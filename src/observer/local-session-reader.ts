import {createHash} from "node:crypto";
import {lstat, open, opendir, realpath, type FileHandle} from "node:fs/promises";
import type {Dirent, Stats} from "node:fs";
import {isAbsolute, relative, resolve} from "node:path";
import type {ConversationRecord, ReadBatch, RuntimeState} from "./conversation-record.js";

const PASS_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 4_096;
const MAX_DEDUPE_KEYS = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-(?:4|7)[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const YEAR = /^\d{4}$/u;
const MONTH = /^(?:0[1-9]|1[0-2])$/u;
const DAY = /^(?:0[1-9]|[12]\d|3[01])$/u;

export type LocalSessionSourceErrorCode =
  | "source_cancelled"
  | "source_closed"
  | "source_invalid_thread"
  | "source_not_found"
  | "source_unavailable"
  | "source_unsafe_path"
  | "source_ambiguous"
  | "source_identity_mismatch"
  | "source_limit"
  | "source_oversize"
  | "source_malformed";

export class LocalSessionSourceError extends Error {
  readonly code: LocalSessionSourceErrorCode;

  constructor(code: LocalSessionSourceErrorCode) {
    super(`local session source error: ${code}`);
    this.name = "LocalSessionSourceError";
    this.code = code;
  }
}

interface FileIdentity {
  device: number;
  inode: number;
  birthtimeMs: number;
}

interface Cursor {
  path: string;
  identity: FileIdentity;
  size: number;
  offset: number;
  validation: string;
  seen: Set<string>;
  seenOrder: string[];
  activeTurnId: string | null;
  forceResetOnGrowth: boolean;
  scanOffset: number;
  scanValidation: string;
  skippingOversized: boolean;
}

interface Candidate {
  path: string;
  identity: FileIdentity;
}

interface ParseContext {
  threadId: string;
  offset: number;
  seen: Set<string>;
  seenOrder: string[];
  activeTurnId: string | null;
  historyTruncated: boolean;
}

interface PassResult {
  records: ConversationRecord[];
  offset: number;
  validation: string;
  activeTurnId: string | null;
  seen: Set<string>;
  seenOrder: string[];
  scanOffset: number;
  scanValidation: string;
  skippingOversized: boolean;
  historyTruncated: boolean;
  caughtUp: boolean;
  partialLine: boolean;
}

interface Envelope {
  type: string;
  timestamp: string | number;
  payload?: unknown;
}

interface Item {
  type: string;
  id?: unknown;
  call_id?: unknown;
  name?: unknown;
  turn_id?: unknown;
  role?: unknown;
  content?: unknown;
  message?: unknown;
  command?: unknown;
  cwd?: unknown;
  input?: unknown;
  output?: unknown;
  aggregated_output?: unknown;
  exit_code?: unknown;
}

function errorCode(error: unknown): LocalSessionSourceErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as {code?: unknown}).code
    : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return "source_not_found";
  if (code === "EACCES" || code === "EPERM") return "source_unavailable";
  return "source_unavailable";
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new LocalSessionSourceError("source_cancelled");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizedPath(value: string): string {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function isWithin(root: string, value: string): boolean {
  const child = relative(normalizedPath(root), normalizedPath(value));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function identityOf(stats: Stats): FileIdentity {
  return {device: stats.dev, inode: stats.ino, birthtimeMs: stats.birthtimeMs};
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  if (left.device !== right.device || left.birthtimeMs !== right.birthtimeMs) return false;
  return left.inode === right.inode;
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new LocalSessionSourceError("source_malformed");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function boundedText(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_TEXT_BYTES) return value;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, MAX_TEXT_BYTES));
}

function boundedTextWithCompleteness(value: string): {text: string; complete: boolean} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_TEXT_BYTES) return {text: value, complete: true};
  return {
    text: new TextDecoder("utf-8").decode(bytes.subarray(0, MAX_TEXT_BYTES)),
    complete: false
  };
}

function dataTextWithCompleteness(value: unknown): {text: string; complete: boolean} | undefined {
  if (typeof value === "string") return boundedTextWithCompleteness(value);
  if (value !== null && typeof value === "object") {
    try {
      return boundedTextWithCompleteness(JSON.stringify(value));
    } catch {
      throw new LocalSessionSourceError("source_malformed");
    }
  }
  return undefined;
}

function dataText(value: unknown): string | undefined {
  if (typeof value === "string") return boundedText(value);
  if (value !== null && typeof value === "object") {
    try {
      return boundedText(JSON.stringify(value));
    } catch {
      throw new LocalSessionSourceError("source_malformed");
    }
  }
  return undefined;
}

function payloadObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalSessionSourceError("source_malformed");
  }
  return value as Record<string, unknown>;
}

function itemObject(value: unknown): Item {
  const item = payloadObject(value);
  if (typeof item.type !== "string") throw new LocalSessionSourceError("source_malformed");
  return item as unknown as Item;
}

function turnIdFrom(value: Record<string, unknown>, fallback: string | null): string | null {
  const direct = stringValue(value.turn_id) ?? stringValue(value.turnId);
  if (direct !== undefined) return direct;
  for (const key of ["internal_chat_message_metadata_passthrough", "metadata"]) {
    const metadata = value[key];
    if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
      const nested = metadata as Record<string, unknown>;
      const nestedTurn = stringValue(nested.turn_id) ?? stringValue(nested.turnId);
      if (nestedTurn !== undefined) return nestedTurn;
    }
  }
  return fallback;
}

function messageText(value: unknown): string | undefined {
  if (typeof value === "string") return boundedText(value);
  if (!Array.isArray(value)) throw new LocalSessionSourceError("source_malformed");
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      throw new LocalSessionSourceError("source_malformed");
    }
    const content = part as Record<string, unknown>;
    const type = content.type;
    if (type === "input_text" || type === "output_text" || type === "text") {
      if (typeof content.text !== "string") throw new LocalSessionSourceError("source_malformed");
      parts.push(content.text);
    }
  }
  return boundedText(parts.join(""));
}

function sourceId(threadId: string, offset: number, stable: unknown): string {
  return stringValue(stable) ?? `${threadId}:${offset}`;
}

function recordId(threadId: string, offset: number, stable: unknown, kind: ConversationRecord["kind"]): string {
  return `${kind}:${sourceId(threadId, offset, stable)}`;
}

function dedupeHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function addRecord(context: ParseContext, record: ConversationRecord, dedupeKey: string): ConversationRecord[] {
  const hash = dedupeHash(dedupeKey);
  if (context.seen.has(hash)) return [];
  if (context.seen.size >= MAX_DEDUPE_KEYS) {
    const oldest = context.seenOrder.shift();
    if (oldest !== undefined) context.seen.delete(oldest);
    context.historyTruncated = true;
  }
  context.seen.add(hash);
  context.seenOrder.push(hash);
  return [record];
}

function normalizeMessage(
  context: ParseContext,
  value: Record<string, unknown>,
  atMs: number,
  offset: number,
  fallbackType?: string
): ConversationRecord[] {
  const role = value.role === "user" || value.role === "assistant"
    ? value.role
    : fallbackType === "UserMessage" ? "user" : fallbackType === "AgentMessage" ? "assistant" : undefined;
  if (role === undefined) return [];
  const content = value.content ?? value.message;
  if (content === undefined) throw new LocalSessionSourceError("source_malformed");
  const record: ConversationRecord = {
    id: sourceId(context.threadId, offset, value.id ?? value.message_id),
    turnId: turnIdFrom(value, context.activeTurnId),
    atMs,
    kind: role
  };
  const text = messageText(content);
  if (text !== undefined) record.text = text;
  if(role==='assistant'&&value.phase==='commentary')record.assistantPhase='commentary';
  if(role==='assistant'&&value.phase==='final_answer')record.assistantPhase='final';
  return addRecord(context, record, `message:${record.id}`);
}

function normalizeTool(
  context: ParseContext,
  value: Record<string, unknown>,
  atMs: number,
  offset: number,
  result: boolean
): ConversationRecord[] {
  const actionId = stringValue(value.call_id) ?? stringValue(value.callId) ?? stringValue(value.id);
  if (actionId === undefined) throw new LocalSessionSourceError("source_malformed");
  const textValue = result
    ? dataText(value.output ?? value.aggregated_output)
    : dataText(value.input ?? value.arguments);
  if (result && value.output === undefined && value.aggregated_output === undefined) {
    throw new LocalSessionSourceError("source_malformed");
  }
  const record: ConversationRecord = {
    id: recordId(context.threadId, offset, value.id, result ? "tool_result" : "tool_start"),
    turnId: turnIdFrom(value, context.activeTurnId),
    atMs,
    kind: result ? "tool_result" : "tool_start",
    actionId
  };
  const toolName = stringValue(value.name);
  if (toolName !== undefined) record.toolName = toolName;
  if (result) {
    record.complete = true;
    record.endedAtMs = atMs;
  } else {
    record.startedAtMs = atMs;
  }
  if (textValue !== undefined) record.text = textValue;
  if (result) {
    const bounded = dataTextWithCompleteness(value.output ?? value.aggregated_output);
    if (bounded !== undefined) {
      record.output = bounded.text;
      record.outputComplete = bounded.complete;
    }
  }
  return addRecord(context, record, `${record.kind}:${actionId}`);
}

function normalizeCommand(
  context: ParseContext,
  value: Item,
  atMs: number,
  offset: number,
  result: boolean
): ConversationRecord[] {
  const actionId = stringValue(value.id) ?? stringValue(value.call_id);
  if (actionId === undefined) throw new LocalSessionSourceError("source_malformed");
  const rawText = result ? value.aggregated_output ?? value.output : value.command;
  if (!result && rawText !== undefined && typeof rawText !== "string") {
    throw new LocalSessionSourceError("source_malformed");
  }
  const record: ConversationRecord = {
    id: recordId(context.threadId, offset, value.id, result ? "tool_result" : "tool_start"),
    turnId: turnIdFrom(value as unknown as Record<string, unknown>, context.activeTurnId),
    atMs,
    kind: result ? "tool_result" : "tool_start",
    actionId
  };
  record.toolName = value.type;
  if (result) {
    record.complete = true;
    record.endedAtMs = atMs;
  } else {
    record.startedAtMs = atMs;
  }
  const cwd = stringValue(value.cwd);
  if (cwd !== undefined) record.cwd = cwd;
  const command = stringValue(value.command);
  if (command !== undefined) record.command = command;
  if (result && value.exit_code === null) record.exitCode = null;
  if (result && typeof value.exit_code === "number" && Number.isFinite(value.exit_code)) {
    record.exitCode = value.exit_code;
  }
  const textValue = dataText(rawText);
  if (textValue !== undefined) record.text = textValue;
  if (result && rawText !== undefined) {
    if (typeof rawText === "string") {
      const bounded = boundedTextWithCompleteness(rawText);
      record.output = bounded.text;
      record.outputComplete = bounded.complete;
    } else {
      const bounded = dataTextWithCompleteness(rawText);
      if (bounded !== undefined) {
        record.output = bounded.text;
        record.outputComplete = bounded.complete;
      }
    }
  }
  return addRecord(context, record, `${record.kind}:${actionId}`);
}

function normalizeEnvelope(context: ParseContext, envelope: Envelope): ConversationRecord[] {
  const atMs = timestampMs(envelope.timestamp);
  const payload = payloadObject(envelope.payload);
  if (envelope.type === "session_meta") return [];

  if (envelope.type === "response_item") {
    const itemType = payload.type;
    if (itemType === "message") return normalizeMessage(context, payload, atMs, context.offset);
    if (itemType === "custom_tool_call" || itemType === "function_call") {
      return normalizeTool(context, payload, atMs, context.offset, false);
    }
    if (itemType === "custom_tool_call_output" || itemType === "function_call_output") {
      return normalizeTool(context, payload, atMs, context.offset, true);
    }
    return [];
  }

  if (envelope.type !== "event_msg") return [];
  const eventType = payload.type;
  if (eventType === "task_started") {
    const turnId = turnIdFrom(payload, null);
    if (turnId === null) throw new LocalSessionSourceError("source_malformed");
    context.activeTurnId = turnId;
    const record: ConversationRecord = {
      id: sourceId(context.threadId, context.offset, payload.id) + ":running",
      turnId,
      atMs,
      kind: "runtime",
      runtime: "running"
    };
    return addRecord(context, record, `runtime:running:${turnId}`);
  }
  if (eventType === "task_complete" || eventType === "task_failed" || eventType === "turn_aborted") {
    const turnId = turnIdFrom(payload, context.activeTurnId);
    const runtime: RuntimeState = eventType === "task_complete"
      ? "waiting"
      : eventType === "task_failed" ? "failed" : "interrupted";
    const record: ConversationRecord = {
      id: sourceId(context.threadId, context.offset, payload.id) + `:${runtime}`,
      turnId,
      atMs,
      kind: "runtime",
      runtime
    };
    const output = addRecord(context, record, `runtime:${runtime}:${turnId ?? context.offset}`);
    context.activeTurnId = null;
    return output;
  }
  if (eventType !== "item_started" && eventType !== "item_completed") return [];

  const item = itemObject(payload.item);
  const itemType = item.type;
  if (itemType === "UserMessage" || itemType === "AgentMessage") {
    return normalizeMessage(context, item as unknown as Record<string, unknown>, atMs, context.offset, itemType);
  }
  if (itemType === "CommandExecution" || itemType === "command_execution") {
    return normalizeCommand(context, item, atMs, context.offset, eventType === "item_completed");
  }
  return [];
}

function parseLine(context: ParseContext, bytes: Buffer): ConversationRecord[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", {fatal: true}).decode(bytes).replace(/\r$/u, "");
  } catch {
    throw new LocalSessionSourceError("source_malformed");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new LocalSessionSourceError("source_malformed");
  }
  const object = payloadObject(raw);
  if (typeof object.type !== "string") throw new LocalSessionSourceError("source_malformed");
  if (object.timestamp === undefined) throw new LocalSessionSourceError("source_malformed");
  return normalizeEnvelope(context, object as unknown as Envelope);
}

async function directoryEntries(path: string, state: {count: number}, signal: AbortSignal): Promise<Dirent[]> {
  checkCancelled(signal);
  let directory;
  try {
    directory = await opendir(path);
  } catch (error) {
    throw new LocalSessionSourceError(errorCode(error));
  }
  const entries: Dirent[] = [];
  try {
    for (;;) {
      checkCancelled(signal);
      const entry = await directory.read();
      if (entry === null) break;
      state.count += 1;
      if (state.count > MAX_DIRECTORY_ENTRIES) throw new LocalSessionSourceError("source_limit");
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries;
}

async function canonicalDirectory(path: string, root: string, signal: AbortSignal): Promise<Stats> {
  checkCancelled(signal);
  let stats: Stats;
  try {
    stats = await lstat(path);
    const canonical = await realpath(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !isWithin(root, canonical) ||
        !samePath(canonical, path)) {
      throw new LocalSessionSourceError("source_unsafe_path");
    }
  } catch (error) {
    if (error instanceof LocalSessionSourceError) throw error;
    throw new LocalSessionSourceError(errorCode(error));
  }
  return stats;
}

async function firstLine(source: string | FileHandle, signal: AbortSignal): Promise<Buffer> {
  let file: FileHandle | undefined;
  try {
    file = typeof source === 'string' ? await open(source, "r") : source;
    const pieces: Buffer[] = [];
    let total = 0;
    for (;;) {
      checkCancelled(signal);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_LINE_BYTES + 1 - total));
      const read = await file.read(chunk, 0, chunk.byteLength, total);
      if (read.bytesRead === 0) throw new LocalSessionSourceError("source_identity_mismatch");
      const bytes = chunk.subarray(0, read.bytesRead);
      const newline = bytes.indexOf(0x0a);
      if (newline >= 0) {
        pieces.push(bytes.subarray(0, newline));
        return Buffer.concat(pieces);
      }
      pieces.push(bytes);
      total += read.bytesRead;
      if (total > MAX_LINE_BYTES) throw new LocalSessionSourceError("source_oversize");
    }
  } catch (error) {
    if (error instanceof LocalSessionSourceError) throw error;
    throw new LocalSessionSourceError(errorCode(error));
  } finally {
    if(typeof source === 'string')await file?.close().catch(() => undefined);
  }
}

function assertSessionIdentity(first:Buffer,threadId:string):void {
  let raw:unknown;
  try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(first));}
  catch{throw new LocalSessionSourceError('source_malformed');}
  const object=payloadObject(raw);
  if(object.type!=='session_meta'||payloadObject(object.payload).id!==threadId)
    throw new LocalSessionSourceError('source_identity_mismatch');
}

async function cursorValidation(file: FileHandle, offset: number, signal: AbortSignal): Promise<string> {
  if (offset === 0) return "";
  checkCancelled(signal);
  const length = Math.min(256, offset);
  const buffer = Buffer.allocUnsafe(length);
  const read = await file.read(buffer, 0, length, offset - length);
  return createHash("sha256").update(buffer.subarray(0, read.bytesRead)).digest("hex");
}

async function runPass(
  file: FileHandle,
  cursor: Cursor,
  threadId: string,
  signal: AbortSignal
): Promise<PassResult> {
  const seen = new Set(cursor.seen);
  const seenOrder = [...cursor.seenOrder];
  let activeTurnId = cursor.activeTurnId;
  let offset = cursor.offset;
  let lineStart = cursor.offset;
  const physicalStart = cursor.skippingOversized ? cursor.scanOffset : cursor.offset;
  let scanOffset = physicalStart;
  let skippingOversized = cursor.skippingOversized;
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let pendingStart = lineStart;
  let readTotal = 0;
  let reachedEof = false;
  let historyTruncated = false;
  const records: ConversationRecord[] = [];

  const consume = (input: Buffer, inputStart: number): void => {
    let remaining = input;
    let remainingStart = inputStart;
    while (remaining.byteLength > 0) {
      if (skippingOversized) {
        const newline = remaining.indexOf(0x0a);
        if (newline < 0) return;
        historyTruncated = true;
        offset = remainingStart + newline + 1;
        lineStart = offset;
        pending = Buffer.alloc(0);
        skippingOversized = false;
        remaining = remaining.subarray(newline + 1);
        remainingStart = offset;
        continue;
      }

      if (pending.byteLength > 0) {
        const newline = remaining.indexOf(0x0a);
        if (newline < 0) {
          if (pending.byteLength + remaining.byteLength > MAX_LINE_BYTES) {
            historyTruncated = true;
            pending = Buffer.alloc(0);
            skippingOversized = true;
            return;
          }
          pending = Buffer.concat([pending, remaining]);
          return;
        }
        const lineLength = pending.byteLength + newline;
        if (lineLength > MAX_LINE_BYTES) {
          historyTruncated = true;
          pending = Buffer.alloc(0);
          offset = remainingStart + newline + 1;
          lineStart = offset;
          remaining = remaining.subarray(newline + 1);
          remainingStart = offset;
          continue;
        }
        const bytes = Buffer.concat([pending, remaining.subarray(0, newline)]);
        const context: ParseContext = {
          threadId,
          offset: pendingStart,
          seen,
          seenOrder,
          activeTurnId,
          historyTruncated
        };
        records.push(...parseLine(context, bytes));
        activeTurnId = context.activeTurnId;
        historyTruncated = context.historyTruncated;
        offset = pendingStart + lineLength + 1;
        lineStart = offset;
        pending = Buffer.alloc(0);
        remaining = remaining.subarray(newline + 1);
        remainingStart = offset;
        continue;
      }

      const newline = remaining.indexOf(0x0a);
      if (newline < 0) {
        if (remaining.byteLength > MAX_LINE_BYTES) {
          historyTruncated = true;
          skippingOversized = true;
          return;
        }
        pendingStart = remainingStart;
        pending = remaining;
        return;
      }
      const context: ParseContext = {
        threadId,
        offset: remainingStart,
        seen,
        seenOrder,
        activeTurnId,
        historyTruncated
      };
      records.push(...parseLine(context, remaining.subarray(0, newline)));
      activeTurnId = context.activeTurnId;
      historyTruncated = context.historyTruncated;
      offset = remainingStart + newline + 1;
      lineStart = offset;
      remaining = remaining.subarray(newline + 1);
      remainingStart = offset;
    }
  };

  while (readTotal < PASS_BYTES) {
    checkCancelled(signal);
    const size = Math.min(64 * 1024, PASS_BYTES - readTotal);
    const chunk = Buffer.allocUnsafe(size);
    const read = await file.read(chunk, 0, size, physicalStart + readTotal);
    if (read.bytesRead === 0) {
      reachedEof = true;
      break;
    }
    const chunkStart = physicalStart + readTotal;
    readTotal += read.bytesRead;
    consume(chunk.subarray(0, read.bytesRead), chunkStart);
    scanOffset = physicalStart + readTotal;
  }

  const partialLine = pending.byteLength > 0 || skippingOversized;
  if (!skippingOversized) scanOffset = offset;
  return {
    records,
    offset,
    validation: await cursorValidation(file, offset, signal),
    activeTurnId,
    seen,
    seenOrder,
    scanOffset,
    scanValidation: await cursorValidation(file, scanOffset, signal),
    skippingOversized,
    historyTruncated,
    caughtUp: reachedEof && !partialLine,
    partialLine
  };
}

export function createLocalSessionReader({root}: {root: string}): {
  read(threadId: string, signal: AbortSignal): Promise<ReadBatch>;
  remove(threadId: string): void;
  close(): Promise<void>;
} {
  const requestedRoot = resolve(root);
  const cursors = new Map<string, Cursor>();
  const locks = new Map<string, Promise<ReadBatch>>();
  const pendingReads = new Set<Promise<ReadBatch>>();
  let closed = false;

  async function canonicalRoot(signal: AbortSignal): Promise<string> {
    checkCancelled(signal);
    try {
      const stats = await lstat(requestedRoot);
      const canonical = await realpath(requestedRoot);
      if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(canonical, requestedRoot)) {
        throw new LocalSessionSourceError("source_unsafe_path");
      }
      return canonical;
    } catch (error) {
      if (error instanceof LocalSessionSourceError) throw error;
      throw new LocalSessionSourceError(errorCode(error));
    }
  }

  async function discover(threadId: string, signal: AbortSignal): Promise<Candidate> {
    const rootPath = await canonicalRoot(signal);
    const suffix = `-${threadId}.jsonl`;
    const pattern = new RegExp(`^rollout-.+-${escapeRegExp(threadId)}\\.jsonl$`, "u");
    const listing = {count: 0};
    const candidates: string[] = [];
    const years = (await directoryEntries(rootPath, listing, signal))
      .filter(entry => YEAR.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    for (const year of years) {
      checkCancelled(signal);
      if (year.isSymbolicLink() || !year.isDirectory()) throw new LocalSessionSourceError("source_unsafe_path");
      const yearPath = resolve(rootPath, year.name);
      await canonicalDirectory(yearPath, rootPath, signal);
      const months = (await directoryEntries(yearPath, listing, signal))
        .filter(entry => MONTH.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
      for (const month of months) {
        if (month.isSymbolicLink() || !month.isDirectory()) throw new LocalSessionSourceError("source_unsafe_path");
        const monthPath = resolve(yearPath, month.name);
        await canonicalDirectory(monthPath, rootPath, signal);
        const days = (await directoryEntries(monthPath, listing, signal))
          .filter(entry => DAY.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
        for (const day of days) {
          if (day.isSymbolicLink() || !day.isDirectory()) throw new LocalSessionSourceError("source_unsafe_path");
          const dayPath = resolve(monthPath, day.name);
          await canonicalDirectory(dayPath, rootPath, signal);
          for (const entry of await directoryEntries(dayPath, listing, signal)) {
            checkCancelled(signal);
            if (!entry.name.endsWith(suffix) || !pattern.test(entry.name)) continue;
            const candidatePath = resolve(dayPath, entry.name);
            let stats: Stats;
            try {
              stats = await lstat(candidatePath);
              const canonical = await realpath(candidatePath);
              if (!stats.isFile() || stats.isSymbolicLink() || !isWithin(rootPath, canonical) ||
                  !samePath(canonical, candidatePath)) {
                throw new LocalSessionSourceError("source_unsafe_path");
              }
            } catch (error) {
              if (error instanceof LocalSessionSourceError) throw error;
              throw new LocalSessionSourceError(errorCode(error));
            }
            candidates.push(candidatePath);
          }
        }
      }
    }
    if (candidates.length === 0) throw new LocalSessionSourceError("source_not_found");
    if (candidates.length !== 1) throw new LocalSessionSourceError("source_ambiguous");
    const path = candidates[0]!;
    let first: Buffer;
    try {
      first = await firstLine(path, signal);
    } catch (error) {
      if (error instanceof LocalSessionSourceError && error.code === "source_identity_mismatch" &&
          cursors.has(threadId)) {
        let stats: Stats;
        try {
          stats = await lstat(path);
        } catch (statError) {
          throw new LocalSessionSourceError(errorCode(statError));
        }
        return {path, identity: identityOf(stats)};
      }
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(first)) as unknown;
    } catch {
      throw new LocalSessionSourceError("source_malformed");
    }
    const object = payloadObject(raw);
    if (object.type !== "session_meta") throw new LocalSessionSourceError("source_identity_mismatch");
    const payload = payloadObject(object.payload);
    if (payload.id !== threadId) throw new LocalSessionSourceError("source_identity_mismatch");
    let stats: Stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      throw new LocalSessionSourceError(errorCode(error));
    }
    return {path, identity: identityOf(stats)};
  }

  async function readOne(threadId: string, signal: AbortSignal): Promise<ReadBatch> {
    if (closed) throw new LocalSessionSourceError("source_closed");
    checkCancelled(signal);
    if (!UUID.test(threadId)) throw new LocalSessionSourceError("source_invalid_thread");
    const candidate = await discover(threadId, signal);
    checkCancelled(signal);
    let cursor = cursors.get(threadId);
    let reset = false;
    if (cursor !== undefined && (!samePath(cursor.path, candidate.path) ||
        !sameIdentity(cursor.identity, candidate.identity))) {
      reset = true;
      cursor = undefined;
    }
    if (cursor === undefined) {
      cursor = {path: candidate.path, identity: candidate.identity, offset: 0, validation: "", seen: new Set(),
        size: 0,
        seenOrder: [], activeTurnId: null, forceResetOnGrowth: false, scanOffset: 0,
        scanValidation: "", skippingOversized: false};
      cursors.set(threadId, cursor);
    }
    let file: FileHandle | undefined;
    try {
      file = await open(candidate.path, "r");
      checkCancelled(signal);
      const stats = await file.stat();
      checkCancelled(signal);
      if(!sameIdentity(candidate.identity,identityOf(stats)))throw new LocalSessionSourceError('source_unsafe_path');
      if(stats.size===0){
        Object.assign(cursor,{size:0,offset:0,validation:'',scanOffset:0,scanValidation:'',
          activeTurnId:null,forceResetOnGrowth:true,skippingOversized:false,seen:new Set<string>(),seenOrder:[]});
        return {records:[],caughtUp:false,reset:true,partialLine:false};
      }
      // Discovery opens a separate handle. Bind the actual content read to its
      // own bounded metadata check; replacement is not permission to read a peer.
      assertSessionIdentity(await firstLine(file,signal),threadId);
      checkCancelled(signal);
      const truncated = stats.size < cursor.size || stats.size < cursor.scanOffset;
      if (!sameIdentity(cursor.identity, identityOf(stats)) || truncated ||
          (cursor.forceResetOnGrowth && stats.size > cursor.offset)) {
        reset = true;
        cursor = {path: candidate.path, identity: identityOf(stats), size: 0, offset: 0, validation: "", seen: new Set(),
          seenOrder: [], activeTurnId: null, forceResetOnGrowth: truncated, scanOffset: 0,
          scanValidation: "", skippingOversized: false};
        cursors.set(threadId, cursor);
      } else {
        const validationOffset = cursor.skippingOversized ? cursor.scanOffset : cursor.offset;
        const validation = cursor.skippingOversized ? cursor.scanValidation : cursor.validation;
        const actualValidation = validationOffset > 0 ? await cursorValidation(file, validationOffset, signal) : validation;
        checkCancelled(signal);
        if (validationOffset > 0 && validation !== actualValidation) {
          reset = true;
          cursor = {path: candidate.path, identity: identityOf(stats), size: 0, offset: 0, validation: "", seen: new Set(),
            seenOrder: [], activeTurnId: null, forceResetOnGrowth: false, scanOffset: 0,
            scanValidation: "", skippingOversized: false};
          cursors.set(threadId, cursor);
        }
      }
      if (cursor === undefined) {
        reset = true;
        cursor = {path: candidate.path, identity: identityOf(stats), size: 0, offset: 0, validation: "", seen: new Set(),
          seenOrder: [], activeTurnId: null, forceResetOnGrowth: false, scanOffset: 0,
          scanValidation: "", skippingOversized: false};
        cursors.set(threadId, cursor);
      }
      const result = await runPass(file, cursor, threadId, signal);
      assertSessionIdentity(await firstLine(file,signal),threadId);
      const endStats = await file.stat();
      checkCancelled(signal);
      if (!sameIdentity(cursor.identity, identityOf(endStats)) || endStats.size < result.scanOffset) {
        cursors.set(threadId, {path: candidate.path, identity: identityOf(endStats), size: 0, offset: 0,
          validation: "", seen: new Set(), seenOrder: [], activeTurnId: null, forceResetOnGrowth: true,
          scanOffset: 0, scanValidation: "", skippingOversized: false});
        return {records: [], caughtUp: false, reset: true, partialLine: false};
      }
      cursor.offset = result.offset;
      cursor.validation = result.validation;
      cursor.seen = result.seen;
      cursor.seenOrder = result.seenOrder;
      cursor.activeTurnId = result.activeTurnId;
      cursor.identity = identityOf(endStats);
      cursor.size = endStats.size;
      cursor.scanOffset = result.scanOffset;
      cursor.scanValidation = result.scanValidation;
      cursor.skippingOversized = result.skippingOversized;
      cursor.forceResetOnGrowth = cursor.forceResetOnGrowth && endStats.size <= cursor.offset;
      const batch: ReadBatch = {
        records: result.records,
        caughtUp: result.caughtUp,
        reset,
        partialLine: result.partialLine
      };
      if (result.historyTruncated) batch.historyTruncated = true;
      return batch;
    } catch (error) {
      if (error instanceof LocalSessionSourceError) throw error;
      throw new LocalSessionSourceError(errorCode(error));
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  function read(threadId: string, signal: AbortSignal): Promise<ReadBatch> {
    if(closed)return Promise.reject(new LocalSessionSourceError('source_closed'));
    if(signal.aborted)return Promise.reject(new LocalSessionSourceError('source_cancelled'));
    if(pendingReads.size>=4)return Promise.reject(new LocalSessionSourceError('source_limit'));
    const previous = locks.get(threadId);
    const current = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
      const batch=await readOne(threadId,signal);checkCancelled(signal);return batch;
    });
    locks.set(threadId, current);
    pendingReads.add(current);
    const cancel=()=>{
      if(locks.get(threadId)===current){locks.delete(threadId);cursors.delete(threadId);}
    };
    signal.addEventListener('abort',cancel,{once:true});
    void current.finally(() => {
      signal.removeEventListener('abort',cancel);pendingReads.delete(current);
      if (locks.get(threadId) === current) locks.delete(threadId);
    }).catch(() => undefined);
    return current;
  }

  return {
    read,
    remove(threadId: string): void {
      cursors.delete(threadId);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...pendingReads]);
      locks.clear();
      cursors.clear();
    }
  };
}
