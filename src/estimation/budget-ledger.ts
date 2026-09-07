import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const amountSchema = z.number().int().min(1).max(20_000_000);
const headerSchema = z.object({ version: z.literal(1), limitMicrousd: amountSchema }).strict();
const rowSchema = z.object({ reservedMicrousd: amountSchema }).strict();
const MAX_BYTES = 262_144;

/** Exclusive, append-only conservative spend authority for one explicitly chosen pilot.
 * Directory must already exist and be user-owned. No identifiers or credentials stored.
 * No refunds: ambiguous dispatches keep their reservation even across crashes.
 * A crash leaves the lock in place: operator inspection is required, never automatic reset.
 */
export async function openBudgetLedger(directory: string, limitMicrousd: number) {
  amountSchema.parse(limitMicrousd);
  const lockPath = join(directory, "estimator-budget.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let journal: FileHandle | undefined;
  let bytes = 0, reserved = 0, closed = false, poisoned = false;
  let queue: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  try {
    journal = await open(join(directory, "estimator-budget.jsonl"), "a+", 0o600);
    bytes = (await journal.stat()).size;
    if (bytes > MAX_BYTES) throw new Error("BUDGET_JOURNAL_TOO_LARGE");
    if (bytes === 0) {
      const header = JSON.stringify({ version: 1, limitMicrousd }) + "\n";
      await journal.writeFile(header); await journal.sync(); bytes = Buffer.byteLength(header);
    } else {
      const contents = await journal.readFile("utf8");
      if (!contents.endsWith("\n")) throw new Error("BUDGET_JOURNAL_INCOMPLETE");
      const lines = contents.trimEnd().split("\n");
      const header = headerSchema.parse(JSON.parse(lines.shift()!));
      if (header.limitMicrousd !== limitMicrousd) throw new Error("BUDGET_LIMIT_MISMATCH");
      for (const line of lines) reserved += rowSchema.parse(JSON.parse(line)).reservedMicrousd;
      if (reserved > limitMicrousd) throw new Error("BUDGET_JOURNAL_EXCEEDS_LIMIT");
    }
  } catch (error) {
    await journal?.close().catch(() => undefined); await lock.close(); await unlink(lockPath); throw error;
  }
  const file = journal;
  return {
    reserve(amount: number): Promise<boolean> {
      const work = queue.then(async () => {
        amountSchema.parse(amount);
        if (closed || poisoned || amount > limitMicrousd - reserved) return false;
        const row = JSON.stringify({ reservedMicrousd: amount }) + "\n";
        const length = Buffer.byteLength(row);
        if (bytes + length > MAX_BYTES) return false;
        try { await file.writeFile(row); await file.sync(); }
        catch { poisoned = true; throw new Error("BUDGET_PERSIST_FAILED"); }
        reserved += amount; bytes += length; return true;
      });
      queue = work.catch(() => undefined); return work;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = queue.then(async () => {
        // A failure to close retains the lock; callers must not assume another owner is safe.
        await file.close(); await lock.close(); await unlink(lockPath);
      });
      return closing;
    }
  };
}
