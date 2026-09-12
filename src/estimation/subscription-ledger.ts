import { randomUUID } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {AdmissionKind, AccountingPurpose} from './subscription-accounting.js';

const counter = z.number().int().nonnegative().max(1_000_000_000);
const usageSchema = z.object({ inputTokens: counter, outputTokens: counter,
  cachedInputTokens: counter.nullable() }).strict().refine(x => x.cachedInputTokens === null || x.cachedInputTokens <= x.inputTokens);
const limitsSchema = z.object({ maxStarts: z.number().int().min(1).max(6),
  maxKnownTokens: z.number().int().min(1).max(50_000) }).strict();
const headerSchema = z.object({ version: z.literal(1), limits: limitsSchema }).strict();
const rowSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reserve"), id: z.string().uuid(), purpose: z.enum(['eta', 'context_compression']).optional() }).strict(),
  z.object({ type: z.literal("not_dispatched"), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal("settle"), id: z.string().uuid(), usage: usageSchema.nullable() }).strict()
]);
type Usage = z.infer<typeof usageSchema>;
type Limits = z.infer<typeof limitsSchema>;
type Row = z.infer<typeof rowSchema>;
const MAX_BYTES = 262_144;

/** Synthetic pilot admission only. Tokens gate future starts, not remote billing.
 * Directory must exist and be owned by the caller. Crash locks require review.
 */
export async function openSubscriptionLedger(directory: string, inputLimits: Limits) {
  const limits = limitsSchema.parse(inputLimits);
  const lockPath = join(directory, "subscription-usage.lock");
  let lock: FileHandle;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new Error("SUBSCRIPTION_OWNER_UNAVAILABLE"); }
  let file: FileHandle | undefined;
  let bytes = 0, starts = 0, knownTokens = 0, unknown = 0;
  let closed = false, poisoned = false;
  let readOnlyLimitMismatch = false;
  const pending = new Set<string>(), seen = new Set<string>();
  const liveReservations=new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const allowed = () => !pending.size && !unknown && starts < limits.maxStarts && knownTokens < limits.maxKnownTokens;
  function validate(row: Row) {
    if (row.type === "reserve") {
      if (seen.has(row.id) || !allowed()) throw new Error("SUBSCRIPTION_INVALID_RESERVATION");
    } else if (!pending.has(row.id)) throw new Error("SUBSCRIPTION_INVALID_SETTLEMENT");
  }
  function apply(row: Row) {
    if (row.type === "reserve") { seen.add(row.id); pending.add(row.id); starts++; }
    else if(row.type==='not_dispatched'){pending.delete(row.id);liveReservations.delete(row.id);}
    else { pending.delete(row.id);liveReservations.delete(row.id); if (row.usage === null) unknown++;
      else knownTokens += row.usage.inputTokens + row.usage.outputTokens; }
  }
  try {
    file = await open(join(directory, "subscription-usage.jsonl"), "a+", 0o600);
    bytes = (await file.stat()).size;
    if (bytes > MAX_BYTES) throw new Error("SUBSCRIPTION_JOURNAL_INVALID");
    if (!bytes) {
      const header = JSON.stringify({ version: 1, limits }) + "\n";
      await file.writeFile(header); await file.sync(); bytes = Buffer.byteLength(header);
    } else {
      const text = await file.readFile("utf8");
      if (!text.endsWith("\n")) throw new Error("SUBSCRIPTION_JOURNAL_INVALID");
      const lines = text.slice(0,-1).split("\n");
      const header = headerSchema.parse(JSON.parse(lines.shift()!));
      if (header.limits.maxStarts !== limits.maxStarts || header.limits.maxKnownTokens !== limits.maxKnownTokens) {
        readOnlyLimitMismatch = true; throw new Error("SUBSCRIPTION_LIMIT_MISMATCH");
      }
      for (const line of lines) { const row = rowSchema.parse(JSON.parse(line)); validate(row); apply(row); }
    }
  } catch {
    let handlesClosed = true;
    await file?.close().catch(() => { handlesClosed = false; });
    await lock.close().catch(() => { handlesClosed = false; });
    // Only undo this invocation's lock after a known read-only configuration
    // mismatch and confirmed handle close. Corruption/I/O failures stay locked.
    if (readOnlyLimitMismatch && handlesClosed) await unlink(lockPath).catch(() => undefined);
    throw new Error("SUBSCRIPTION_JOURNAL_UNAVAILABLE");
  }
  const journal = file;
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn); queue = result.catch(() => undefined); return result;
  }
  async function append(row: Row) {
    const line = JSON.stringify(row) + "\n", size = Buffer.byteLength(line);
    if (bytes + size > MAX_BYTES) { poisoned = true; throw new Error("SUBSCRIPTION_JOURNAL_FULL"); }
    try { await journal.writeFile(line); await journal.sync(); }
    catch { poisoned = true; throw new Error("SUBSCRIPTION_PERSIST_FAILED"); }
    bytes += size; apply(row);
  }
  return {
    reserve(_admissionKind?: AdmissionKind, purpose: AccountingPurpose = 'eta'): Promise<string | null> {
      return serial(async () => {
        if (closed || poisoned || !allowed()) return null;
        const id = randomUUID(); await append({ type: "reserve", id, ...(purpose === 'eta' ? {} : {purpose}) });liveReservations.add(id); return id;
      });
    },
    settle(id: string, usage: Usage | null): Promise<void> {
      if (closed || poisoned) return Promise.reject(new Error("SUBSCRIPTION_CLOSED"));
      // Parse/copy now so later caller mutation cannot change queued accounting.
      let row: Row;
      try { row = rowSchema.parse({ type: "settle", id, usage }); }
      catch { return Promise.reject(new Error("SUBSCRIPTION_USAGE_INVALID")); }
      return serial(async () => {
        if (poisoned) throw new Error("SUBSCRIPTION_CLOSED");
        validate(row); await append(row);
      });
    },
    cancelBeforeDispatch(id:string):Promise<void> {
      if(closed||poisoned)return Promise.reject(new Error('SUBSCRIPTION_CLOSED'));
      let row:Row;
      try{row=rowSchema.parse({type:'not_dispatched',id});}catch{return Promise.reject(new Error('SUBSCRIPTION_INVALID_SETTLEMENT'));}
      return serial(async()=>{
        if(poisoned)throw new Error('SUBSCRIPTION_CLOSED');
        if(!liveReservations.has(row.id))throw new Error('SUBSCRIPTION_INVALID_SETTLEMENT');
        validate(row);await append(row);
      });
    },
    snapshot() { return { starts, knownTokens, unresolved: pending.size, unknown }; },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = queue.then(async () => {
        try { await journal.close(); await lock.close(); if (!poisoned) await unlink(lockPath); }
        catch { throw new Error("SUBSCRIPTION_CLOSE_FAILED"); }
      });
      return closing;
    }
  };
}
