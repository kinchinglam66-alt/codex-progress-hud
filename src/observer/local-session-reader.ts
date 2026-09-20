import {createHash,type Hash} from "node:crypto";
import {lstat, open, opendir, realpath, type FileHandle} from "node:fs/promises";
import type {Dirent, Stats} from "node:fs";
import {isAbsolute, relative, resolve} from "node:path";
import type {ConversationRecord, ReadBatch, RuntimeOutcome, RuntimeState} from "./conversation-record.js";
import {parseCodexCheckpoint, type NativeCodexCheckpoint} from "./codex-checkpoint.js";
import {createHistorySnapshot, type HistoryGap, type HistorySnapshot, type HistorySnapshotPage} from "./history-snapshot.js";
import {createNativeSourceSnapshot,type NativeSourceSnapshot} from './native-source-snapshot.js';
import type {NativeSourceDestination,NativeTurnSource} from './native-source-request.js';
import {createNativeTurnIndex,type NativeTurnIndex} from './native-turn-boundary.js';

const PASS_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const SNAPSHOT_PAGE_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_LINE_BYTES = 16 * 1024 * 1024;
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
  | "source_unobserved"
  | "source_not_found"
  | "source_unavailable"
  | "source_unsafe_path"
  | "source_ambiguous"
  | "source_identity_mismatch"
  | "source_limit"
  | "source_oversize"
  | "source_malformed"
  | "source_terminal_unsupported"
  | "source_checkpoint_unsupported";

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
  projectionStart?:number;
  native?:NativeCursorState;
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

interface NativeCursorState {
  index:NativeTurnIndex;hash:Hash;epoch:number;digest:string;
  baseDigest:string|null;sawCheckpoint:boolean;unsupportedCutoff:boolean;invalid:boolean;
  scannedThrough?:number;pending?:{chunks:ReadonlyArray<Buffer>;bytes:number}|undefined;
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
  options: ParseOptions;
  gaps: Set<HistoryGap>;
}

interface ParseOptions {
  preserveText: boolean;
  inferTurnId: boolean;
  dedupeLimit: number | null;
}

const LEGACY_PARSE_OPTIONS: ParseOptions = {
  preserveText: false,
  inferTurnId: true,
  dedupeLimit: MAX_DEDUPE_KEYS
};

const SNAPSHOT_PARSE_OPTIONS: ParseOptions = {
  preserveText: true,
  inferTurnId: false,
  dedupeLimit: MAX_DEDUPE_KEYS
};

interface PassResult {
  native:NativeCursorState;
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

interface SnapshotState {
  checkpointRange?: {start:number;end:number;digest:string};
  currentTurnId?:string;
  path: string;
  identity: FileIdentity;
  watermark: number;
  nextOffset: number;
  validation: string;
  prefixValidation: string;
  prefixLength: number;
  activeTurnId: string | null;
  seen: Set<string>;
  seenOrder: string[];
  gaps: Set<HistoryGap>;
  closed: boolean;
}

interface CheckpointScanResult {
  checkpoint?: NativeCodexCheckpoint;
  checkpointRange?: {start:number;end:number;digest:string};
  startOffset: number;
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

function boundedText(value: string, preserve = false): string {
  if (preserve) return value;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_TEXT_BYTES) return value;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, MAX_TEXT_BYTES));
}

function boundedTextWithCompleteness(value: string, preserve = false): {text: string; complete: boolean} {
  if (preserve) return {text: value, complete: true};
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_TEXT_BYTES) return {text: value, complete: true};
  return {
    text: new TextDecoder("utf-8").decode(bytes.subarray(0, MAX_TEXT_BYTES)),
    complete: false
  };
}

function dataTextWithCompleteness(value: unknown, preserve = false): {text: string; complete: boolean} | undefined {
  if (typeof value === "string") return boundedTextWithCompleteness(value, preserve);
  if (value !== null && typeof value === "object") {
    try {
      return boundedTextWithCompleteness(JSON.stringify(value), preserve);
    } catch {
      throw new LocalSessionSourceError("source_malformed");
    }
  }
  return undefined;
}

function dataText(value: unknown, preserve = false): string | undefined {
  if (typeof value === "string") return boundedText(value, preserve);
  if (value !== null && typeof value === "object") {
    try {
      return boundedText(JSON.stringify(value), preserve);
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

function turnIdFrom(value: Record<string, unknown>, fallback: string | null, inferFallback = true): string | null {
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
  return inferFallback ? fallback : null;
}

function messageText(value: unknown, options: ParseOptions, markUnsupported: () => void,
  ordered?: NonNullable<ConversationRecord['contentParts']>,allowLocalImages=false): string | undefined {
  if (typeof value === "string") return boundedText(value, options.preserveText);
  if (!Array.isArray(value)) throw new LocalSessionSourceError("source_malformed");
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
      ordered?.push({type:'text',text:part});
      continue;
    }
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      throw new LocalSessionSourceError("source_malformed");
    }
    const content = part as Record<string, unknown>;
    const type = content.type;
    if (type === "input_text" || type === "output_text" || type === "text" || (options.preserveText && type === "Text")) {
      if (typeof content.text !== "string") throw new LocalSessionSourceError("source_malformed");
      parts.push(content.text);
      ordered?.push({type:'text',text:content.text});
      continue;
    }
    if(ordered&&type==='local_image'){
      if(!allowLocalImages){markUnsupported();continue;}
      if(typeof content.path!=='string'||content.path.trim().length===0){
        // Live projection remains readable; full-history preflight owns fidelity.
        if(!options.preserveText){markUnsupported();continue;}
        throw new LocalSessionSourceError('source_malformed');
      }
      ordered.push({type:'local_image',path:content.path});
      continue;
    }
    if(ordered&&type==='input_image'){
      if(typeof content.image_url!=='string'||content.image_url.trim().length===0){
        if(!options.preserveText){markUnsupported();continue;}
        throw new LocalSessionSourceError('source_malformed');
      }
      ordered.push({type:'input_image',imageUrl:content.image_url});
      continue;
    }
    markUnsupported();
  }
  return boundedText(parts.join(""), options.preserveText);
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
  // Identity is only a replay key. Bind it to the complete normalized body so
  // an identity reuse with changed text/output/completion evidence is retained.
  // Timestamp and representation-specific labels differ between mirrored
  // envelopes. These canonical content/completion fields preserve conflicts
  // while allowing an exact replay of the same semantic record to collapse.
  const content = {kind:record.kind,text:record.text,contentParts:record.contentParts,imageFingerprint:record.imageFingerprint,imageContextPending:record.imageContextPending,output:record.output,
    outputComplete:record.outputComplete,complete:record.complete,exitCode:record.exitCode,
    assistantPhase:record.assistantPhase,runtime:record.runtime,outcome:record.outcome};
  const hash = dedupeHash(`${dedupeKey}\0${JSON.stringify(content)}`);
  if (context.seen.has(hash)) return [];
  if (context.options.dedupeLimit !== null && context.seen.size >= context.options.dedupeLimit) {
    const oldest = context.seenOrder.shift();
    if (oldest !== undefined) context.seen.delete(oldest);
    context.historyTruncated = true;
    // Keep reading all later text, but do not claim global deduplication once
    // the bounded metadata window evicts an identity. No raw transcript cache.
    if (context.options.preserveText) context.gaps.add("deduplication_window");
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
    turnId: turnIdFrom(value, context.activeTurnId, context.options.inferTurnId),
    sourceTurnId: turnIdFrom(value, null, false),
    atMs,
    kind: role
  };
  const ordered:NonNullable<ConversationRecord['contentParts']>=[];
  const conflictingRole=(fallbackType==='AgentMessage'&&role!=='assistant')||
    (fallbackType==='UserMessage'&&role!=='user');
  const unsupported=()=>{context.gaps.add('unsupported_payload');record.imageContextPending=true;};
  if(conflictingRole){unsupported();return addRecord(context,record,`message:${record.id}`);}
  const text = messageText(content, context.options, unsupported,ordered,role==='user');
  if (text !== undefined) record.text = text;
  if(ordered.some(part=>part.type!=='text')){
    record.imageCount=ordered.filter(part=>part.type!=='text').length;
    record.imageFingerprint=dedupeHash(JSON.stringify(ordered));
    if(context.options.preserveText)record.contentParts=ordered;
  }
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
    ? dataText(value.output ?? value.aggregated_output, context.options.preserveText)
    : dataText(value.input ?? value.arguments, context.options.preserveText);
  if (result && value.output === undefined && value.aggregated_output === undefined) {
    throw new LocalSessionSourceError("source_malformed");
  }
  const record: ConversationRecord = {
    id: recordId(context.threadId, offset, value.id, result ? "tool_result" : "tool_start"),
    turnId: turnIdFrom(value, context.activeTurnId, context.options.inferTurnId),
    sourceTurnId: turnIdFrom(value, null, false),
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
    const bounded = dataTextWithCompleteness(value.output ?? value.aggregated_output, context.options.preserveText);
    if (bounded !== undefined) {
      record.output = bounded.text;
      record.outputComplete = bounded.complete;
    }
  }
  // Full-history tool results with explicit attribution are not interchangeable
  // with inferred ones. Keep both when needed; a prior unassigned response must
  // not erase the mirror's source turn (or a result from another explicit turn).
  const attribution = context.options.preserveText && result ? `:${record.sourceTurnId ?? 'unassigned'}` : '';
  return addRecord(context, record, `${record.kind}:${actionId}${attribution}`);
}

function delegatedTaskText(
  context: ParseContext,
  value: Record<string, unknown>
): string | undefined {
  if (value.type !== "function_call_output" || value.name !== "create_thread" ||
      value.namespace !== "codex_app" || stringValue(value.id) === undefined ||
      typeof value.output !== "string") return undefined;
  const metadata = value.internal_chat_message_metadata_passthrough;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const passthrough = metadata as Record<string, unknown>;
  if (Object.keys(passthrough).length !== 2 || typeof passthrough.create_time !== "number" ||
      !Number.isFinite(passthrough.create_time) || stringValue(passthrough.turn_id) === undefined ||
      context.activeTurnId === null || passthrough.turn_id !== context.activeTurnId) return undefined;
  const match = /^<codex_delegation>\r?\n  <source_thread_id>([^<>\r\n]+)<\/source_thread_id>\r?\n  <input>([\s\S]+)<\/input>\r?\n<\/codex_delegation>$/u.exec(value.output);
  if (match === null || !UUID.test(match[1]!) || /<\/?codex_delegation\b/iu.test(match[2]!)) return undefined;
  return boundedText(match[2]!, context.options.preserveText);
}

function normalizeHostDelegation(
  context: ParseContext,
  value: Record<string, unknown>,
  atMs: number,
  offset: number,
  toolRecords: ConversationRecord[]
): ConversationRecord[] {
  const taskText = delegatedTaskText(context, value);
  if (taskText === undefined) return toolRecords;
  const actionId = stringValue(value.id)!;
  const task: ConversationRecord = {
    id: recordId(context.threadId, offset, `host-delegation:${actionId}`, "user"),
    turnId: context.activeTurnId,
    sourceTurnId: turnIdFrom(value, null, false),
    atMs,
    kind: "user",
    text: taskText
  };
  return [...toolRecords, ...addRecord(context, task, `host_delegation:${context.activeTurnId}:${actionId}`)];
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
    turnId: turnIdFrom(value as unknown as Record<string, unknown>, context.activeTurnId,
      context.options.inferTurnId),
    sourceTurnId: turnIdFrom(value as unknown as Record<string, unknown>, null, false),
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
  const textValue = dataText(rawText, context.options.preserveText);
  if (textValue !== undefined) record.text = textValue;
  if (result && rawText !== undefined) {
    if (typeof rawText === "string") {
      const bounded = boundedTextWithCompleteness(rawText, context.options.preserveText);
      record.output = bounded.text;
      record.outputComplete = bounded.complete;
    } else {
      const bounded = dataTextWithCompleteness(rawText, context.options.preserveText);
      if (bounded !== undefined) {
        record.output = bounded.text;
        record.outputComplete = bounded.complete;
      }
    }
  }
  return addRecord(context, record, `${record.kind}:${actionId}`);
}

function validFunctionCallOutput(payload:Record<string,unknown>,raw:Record<string,unknown>,threadId:string):boolean {
  const identityFields=[payload,raw];
  const explicitTurns=identityFields.flatMap(fields=>
    ['turn_id','turnId'].filter(key=>Object.hasOwn(fields,key)).map(key=>fields[key]));
  return payload.type==='item_completed' &&
    [raw.id,raw.name,raw.namespace].every(value=>stringValue(value)!==undefined) &&
    typeof raw.output==='string' &&
    Object.keys(payload).every(key=>['type','item','thread_id','threadId','turn_id','turnId','started_at_ms','completed_at_ms'].includes(key)) &&
    Object.keys(raw).every(key=>['type','id','name','namespace','output','thread_id','threadId','turn_id','turnId'].includes(key)) &&
    identityFields.every(fields=>['thread_id','threadId'].every(key=>!Object.hasOwn(fields,key)||fields[key]===threadId)) &&
    ['started_at_ms','completed_at_ms'].every(key=>!Object.hasOwn(payload,key)||
      (typeof payload[key]==='number'&&Number.isFinite(payload[key])&&payload[key]>=0)) &&
    explicitTurns.every(turn=>stringValue(turn)!==undefined&&turn===explicitTurns[0]);
}

function normalizeEnvelope(context: ParseContext, envelope: Envelope): ConversationRecord[] {
  const atMs = timestampMs(envelope.timestamp);
  const payload = payloadObject(envelope.payload);
  if (["session_meta", "world_state", "turn_context", "token_usage_record"].includes(envelope.type)) return [];

  if (envelope.type === "response_item") {
    const itemType = payload.type;
    if (itemType === "message") return normalizeMessage(context, payload, atMs, context.offset);
    if (itemType === "custom_tool_call" || itemType === "function_call") {
      return normalizeTool(context, payload, atMs, context.offset, false);
    }
    if (itemType === "custom_tool_call_output" || itemType === "function_call_output") {
      return normalizeHostDelegation(context, payload, atMs, context.offset,
        normalizeTool(context, payload, atMs, context.offset, true));
    }
    if (itemType !== "reasoning") context.gaps.add("unsupported_payload");
    return [];
  }

  if (envelope.type !== "event_msg") {
    context.gaps.add(envelope.type === "compacted" ? "upstream_truncated" : "unsupported_payload");
    return [];
  }
  const eventType = payload.type;
  if(eventType==='user_message'||eventType==='agent_message'){
    if(typeof payload.message!=='string'||
      ['images','local_images'].some(key=>payload[key]!==undefined&&(!Array.isArray(payload[key])||(payload[key] as unknown[]).some(value=>typeof value!=='string')))){
      context.gaps.add('unsupported_payload');return [];
    }
    const role=eventType==='user_message'?'user':'assistant';
    // Event mirrors can also be the only surviving representation. Preserve
    // all event fields as quoted source data; never blindly discard them as
    // telemetry or conflate text-equal messages without a shared identity.
    const content:Record<string,unknown>[]=[{type:role==='user'?'input_text':'output_text',text:JSON.stringify(payload)}];
    for(const image of payload.images as string[]??[])content.push({type:'input_image',image_url:image});
    for(const path of payload.local_images as string[]??[])content.push({type:'local_image',path});
    return normalizeMessage(context,{...payload,role,content},atMs,context.offset);
  }
  if (context.options.preserveText) {
    if (eventType === 'token_count' && Object.keys(payload).every(key => ['type','info','rate_limits'].includes(key)) &&
      'info' in payload && 'rate_limits' in payload &&
      (payload.info === null || typeof payload.info === 'object' && !Array.isArray(payload.info)) &&
      (payload.rate_limits === null || typeof payload.rate_limits === 'object' && !Array.isArray(payload.rate_limits))) return [];
    if (eventType === 'thread_settings_applied' || eventType === 'thread_goal_updated') {
      const sourceThread = eventType === 'thread_settings_applied' ? payload.thread_id : payload.threadId;
      const content = eventType === 'thread_settings_applied' ? payload.thread_settings : payload.goal;
      if (sourceThread !== context.threadId ||
        !(content !== null && typeof content === 'object' && !Array.isArray(content) || eventType === 'thread_goal_updated' && content === null)) {
        context.gaps.add('unsupported_payload'); return [];
      }
      // Preserve the full event as source data, including goal text. Do not
      // synthesize a user request, active turn or completion from metadata.
      const id = sourceId(context.threadId, context.offset, undefined);
      return addRecord(context, {id,turnId:null,sourceTurnId:null,sourceScope:'conversation',atMs,
        kind:'tool_result',toolName:`codex:${eventType}`,text:JSON.stringify(payload)}, `metadata:${id}`);
    }
  }
  if (eventType === "task_started") {
    const turnId = turnIdFrom(payload, null);
    if (turnId === null) throw new LocalSessionSourceError("source_malformed");
    context.activeTurnId = turnId;
    const record: ConversationRecord = {
      id: sourceId(context.threadId, context.offset, payload.id) + ":running",
      turnId,
      sourceTurnId: turnIdFrom(payload, null, false),
      atMs,
      kind: "runtime",
      runtime: "running"
    };
    return addRecord(context, record, `runtime:running:${turnId}`);
  }
  if (eventType === "task_complete" || eventType === "task_failed" || eventType === "turn_aborted") {
    const turnId = turnIdFrom(payload, context.activeTurnId, context.options.inferTurnId);
    const runtime: RuntimeState = eventType === "task_complete"
      ? "waiting"
      : eventType === "task_failed" ? "failed" : "interrupted";
    const outcome: RuntimeOutcome = eventType === "task_complete"
      ? "completed"
      : eventType === "task_failed" ? "failed" : "interrupted";
    const record: ConversationRecord = {
      id: sourceId(context.threadId, context.offset, payload.id) + `:${runtime}`,
      turnId,
      sourceTurnId: turnIdFrom(payload, null, false),
      atMs,
      kind: "runtime",
      runtime,
      outcome
    };
    const output = addRecord(context, record, `runtime:${runtime}:${turnId ?? context.offset}`);
    if (turnId === context.activeTurnId) context.activeTurnId = null;
    return output;
  }
  if (eventType !== "item_started" && eventType !== "item_completed") {
    // These envelope events carry lifecycle/telemetry only and are not source
    // task text. Everything else is conservatively treated as potentially
    // content-bearing until a parser is added for it.
    const knownNonContent = new Set([
      "turn_started", "turn_completed", "token_usage_updated", "thread_started",
      "thread_completed", "model_selected"
    ]);
    if (typeof eventType !== "string" || !knownNonContent.has(eventType)) context.gaps.add("unsupported_payload");
    return [];
  }

  const item = itemObject(payload.item);
  const itemType = item.type;
  // Match response_item/reasoning: internal reasoning is not source task text.
  if (itemType === "Reasoning") return [];
  if (context.options.preserveText && itemType === 'ContextCompaction' &&
    Object.keys(payload).every(key => ['type','item','thread_id','threadId','turn_id','turnId','started_at_ms','completed_at_ms'].includes(key)) &&
    ['started_at_ms','completed_at_ms'].every(key => !Object.hasOwn(payload,key) ||
      (typeof payload[key] === 'number' && Number.isFinite(payload[key]) && payload[key] >= 0)) &&
    ['thread_id','threadId','turn_id','turnId'].every(key =>
      !Object.hasOwn(payload,key) || stringValue(payload[key]) !== undefined) &&
    ['thread_id','threadId'].every(key =>
      !Object.hasOwn(payload,key) || payload[key] === context.threadId) &&
    !(Object.hasOwn(payload,'turn_id') && Object.hasOwn(payload,'turnId') && payload.turn_id !== payload.turnId) &&
    stringValue(item.id) !== undefined && Object.keys(item).every(key => ['type','id'].includes(key))) return [];
  // Keep legacy/strict estimator turnId behavior intact. Research may use an
  // explicit outer event ID, but conflicting explicit IDs are never inferred.
  const outerTurn=turnIdFrom(payload,null,false);
  const withSourceTurn=(records:ConversationRecord[])=>records.map(record=>{
    const innerTurn=record.sourceTurnId??null;
    if(innerTurn!==null&&outerTurn!==null&&innerTurn!==outerTurn)context.gaps.add('unattributed_record');
    const sourceTurnId=innerTurn!==null&&outerTurn!==null&&innerTurn!==outerTurn?null:innerTurn??outerTurn;
    return {...record,sourceTurnId};
  });
  if (context.options.preserveText && itemType === 'FunctionCallOutput') {
    const raw = item as unknown as Record<string, unknown>;
    if (!validFunctionCallOutput(payload,raw,context.threadId)) {context.gaps.add('unsupported_payload');return [];}
    // Same output semantics as response_item/function_call_output. Normalize
    // before deduplication so mirrors collapse, while changed output survives.
    // A tool-result envelope is never promoted to a user/delegation instruction.
    return withSourceTurn(normalizeTool(context, {
      ...raw, ...(outerTurn !== null ? {turn_id:outerTurn} : {})
    }, atMs, context.offset, true));
  }
  if (itemType === "UserMessage" || itemType === "AgentMessage") {
    return withSourceTurn(normalizeMessage(context, item as unknown as Record<string, unknown>, atMs, context.offset, itemType));
  }
  if (itemType === "CommandExecution" || itemType === "command_execution") {
    return withSourceTurn(normalizeCommand(context, item, atMs, context.offset, eventType === "item_completed"));
  }
  if(context.options.preserveText&&itemType==='Extension'){
    const raw=item as unknown as Record<string,unknown>;
    const identityFields=[payload,raw];
    const explicitTurns=identityFields.flatMap(fields=>['turn_id','turnId'].filter(key=>Object.hasOwn(fields,key)).map(key=>fields[key]));
    const action=raw.action;
    const knownShape=raw.kind==='clock.sleep'
      ? typeof raw.durationMs==='number'&&Number.isFinite(raw.durationMs)&&raw.durationMs>=0
      : raw.kind==='web.search'&&typeof raw.query==='string'&&Array.isArray(raw.results)&&
        action!==null&&typeof action==='object'&&!Array.isArray(action)&&
        stringValue((action as Record<string,unknown>).type)!==undefined;
    const valid=knownShape&&stringValue(raw.id)!==undefined&&
      identityFields.every(fields=>['thread_id','threadId'].every(key=>!Object.hasOwn(fields,key)||fields[key]===context.threadId)&&
        ['started_at_ms','completed_at_ms'].every(key=>!Object.hasOwn(fields,key)||
          (typeof fields[key]==='number'&&Number.isFinite(fields[key])&&fields[key]>=0)))&&
      explicitTurns.every(turn=>stringValue(turn)!==undefined&&turn===explicitTurns[0]);
    if(!valid){context.gaps.add('unsupported_payload');return [];}
    // Preserve the full structured envelope as data, never a lifecycle signal.
    const completed=eventType==='item_completed';
    return withSourceTurn(normalizeTool(context,{...raw,name:`codex:Extension:${raw.kind}`,
      ...(completed?{output:envelope}:{input:envelope})},atMs,context.offset,completed));
  }
  if (context.options.preserveText && itemType === 'McpToolCall') {
    const raw = item as unknown as Record<string, unknown>;
    const completed = eventType === 'item_completed';
    const explicitTurns = [payload,raw].flatMap(fields=>['turn_id','turnId'].filter(key=>Object.hasOwn(fields,key)).map(key=>fields[key]));
    const valid = [raw.id,raw.server,raw.tool,raw.status].every(value=>stringValue(value)!==undefined) &&
      Object.hasOwn(raw,'arguments') && (!completed || Object.hasOwn(raw,'result') || Object.hasOwn(raw,'error')) &&
      explicitTurns.every(turn=>stringValue(turn)!==undefined&&turn===explicitTurns[0]) &&
      [payload,raw].every(fields=>['thread_id','threadId'].every(key=>!Object.hasOwn(fields,key)||fields[key]===context.threadId));
    if (!valid) {context.gaps.add('unsupported_payload');return [];}
    // Native MCP records are observed data, never executable instructions.
    // Preserve arguments, result/error and extension fields without truncation.
    return withSourceTurn(normalizeTool(context,{...raw,name:'codex:McpToolCall',
      ...(completed?{output:raw}:{input:raw})},atMs,context.offset,completed));
  }
  if (context.options.preserveText && (itemType === 'FileChange' || itemType === 'CollabAgentToolCall')) {
    const raw = item as unknown as Record<string, unknown>;
    const valid = stringValue(raw.id) !== undefined && stringValue(raw.status) !== undefined &&
      (itemType === 'FileChange' ? raw.changes !== null && typeof raw.changes === 'object' :
        stringValue(raw.tool) !== undefined && Array.isArray(raw.receiver_thread_ids));
    if (!valid) {context.gaps.add('unsupported_payload');return [];}
    const completed = eventType === 'item_completed';
    return withSourceTurn(normalizeTool(context, {...raw,name:`codex:${itemType}`,
      ...(completed ? {output:raw} : {input:raw})},atMs,context.offset,completed));
  }
  context.gaps.add("unsupported_payload");
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

async function prefixValidation(file: FileHandle, length: number, signal: AbortSignal): Promise<string> {
  if (length === 0) return "";
  checkCancelled(signal);
  const buffer = Buffer.allocUnsafe(length);
  const read = await file.read(buffer, 0, length, 0);
  return createHash("sha256").update(buffer.subarray(0, read.bytesRead)).digest("hex");
}

/** Hash the entire attested range with bounded allocation, not only the small
 * UI-reader cursor window. Short reads and rewrites cannot attest a base. */
async function completePrefixValidation(file:FileHandle,length:number,signal:AbortSignal,start=0):Promise<string>{
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);
  let offset=start;
  while(offset<length){
    checkCancelled(signal);
    const read=await file.read(buffer,0,Math.min(buffer.length,length-offset),offset);
    if(read.bytesRead===0)throw new LocalSessionSourceError('source_identity_mismatch');
    hash.update(buffer.subarray(0,read.bytesRead));offset+=read.bytesRead;
  }
  return hash.digest('hex');
}

function checkpointObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function inspectCheckpointLine(bytes: Buffer): NativeCodexCheckpoint | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)) as unknown;
  } catch {
    throw new LocalSessionSourceError("source_checkpoint_unsupported");
  }
  const object = checkpointObject(raw);
  if (object?.type !== "compacted") return null;
  const payload = checkpointObject(object.payload);
  // Preserve the legacy compacted/truncated marker. Only envelopes carrying
  // native replacement history are checkpoint candidates.
  if (payload === null || !("replacement_history" in payload)) return null;
  try {
    const checkpoint = parseCodexCheckpoint(raw);
    if (checkpoint === null) throw new Error("CHECKPOINT_UNSUPPORTED");
    return checkpoint;
  } catch {
    throw new LocalSessionSourceError("source_checkpoint_unsupported");
  }
}

async function scanReverseLines<T>(
  file: FileHandle,
  watermark: number,
  signal: AbortSignal,
  inspectLine:(bytes:Buffer,start:number,end:number)=>T|null
): Promise<T|null> {
  // A replacement checkpoint supersedes the prefix. Search backwards so a
  // long-lived rollout costs only its latest effective window, not its lifetime.
  // Reject malformed complete suffix rows and the newest unsupported checkpoint;
  // never skip them to revive an older, apparently usable context.
  let position=watermark,discardPartialTail=true,lineEnd=0;
  let chunks:Buffer[]=[],pendingBytes=0;
  const add=(part:Buffer)=>{
    pendingBytes+=part.length;
    if(pendingBytes>SNAPSHOT_MAX_LINE_BYTES)throw new LocalSessionSourceError('source_checkpoint_unsupported');
    if(part.length)chunks.push(part);
  };
  const inspect=():T|null=>{
    const bytes=Buffer.concat(chunks.reverse(),pendingBytes);
    chunks=[];pendingBytes=0;
    return inspectLine(bytes,lineEnd-bytes.length,lineEnd+1);
  };
  while(position>0){
    checkCancelled(signal);
    const size=Math.min(64*1024,position),start=position-size,chunk=Buffer.allocUnsafe(size);
    let filled=0;
    while(filled<size){
      checkCancelled(signal);
      const read=await file.read(chunk,filled,size-filled,start+filled);
      if(read.bytesRead===0)throw new LocalSessionSourceError('source_identity_mismatch');
      filled+=read.bytesRead;
    }
    position=start;
    let end=size;
    if(discardPartialTail){
      const newline=chunk.lastIndexOf(0x0a);
      if(newline<0)continue;
      discardPartialTail=false;end=newline;lineEnd=start+newline;
    }
    while(end>0){
      const newline=chunk.lastIndexOf(0x0a,end-1);
      if(newline<0){add(chunk.subarray(0,end));break;}
      add(chunk.subarray(newline+1,end));
      const result=inspect();if(result)return result;
      lineEnd=start+newline;end=newline;
    }
  }
  if(!discardPartialTail&&pendingBytes){const result=inspect();if(result)return result;}
  return null;
}

async function scanLatestCheckpoint(file:FileHandle,watermark:number,signal:AbortSignal):Promise<CheckpointScanResult>{
  return await scanReverseLines(file,watermark,signal,(bytes,start,end)=>{
    const checkpoint=inspectCheckpointLine(bytes);
    return checkpoint===null?null:{checkpoint,startOffset:end,
      checkpointRange:{start,end,digest:createHash('sha256').update(bytes).update('\n').digest('hex')}};
  })??{startOffset:0};
}

/** Local projection only. The native model snapshot is independently attested. */
async function scanTurnStart(file:FileHandle,watermark:number,signal:AbortSignal,matchesTurn:(id:string)=>boolean):Promise<number>{
  const boundary=await scanReverseLines(file,watermark,signal,(bytes,start)=>{
    let raw:unknown;
    try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch{throw new LocalSessionSourceError('source_malformed');}
    const row=checkpointObject(raw);
    if(!row||typeof row.type!=='string')throw new LocalSessionSourceError('source_malformed');
    timestampMs(row.timestamp);
    const payload=checkpointObject(row.payload);
    if(row.type!=='event_msg'||payload?.type!=='task_started')return null;
    const turn=turnIdFrom(payload,null);
    if(turn===null)throw new LocalSessionSourceError('source_malformed');
    return matchesTurn(turn)?{offset:start}:null;
  });
  if(boundary===null)throw new LocalSessionSourceError('source_unobserved');
  return boundary.offset;
}

async function runPass(
  file: FileHandle,
  cursor: Cursor,
  threadId: string,
  signal: AbortSignal
): Promise<PassResult> {
  if(!cursor.native)throw new LocalSessionSourceError('source_unobserved');
  const native:NativeCursorState={...cursor.native,index:cursor.native.index.copy(),hash:cursor.native.hash.copy()};
  const onEnvelope=(raw:unknown,bytes:Buffer,start:number)=>{
    native.index.observe(raw,start,start+bytes.length+1);
    native.hash.update(bytes).update('\n');
    const row=raw as {type?:unknown;payload?:{type?:unknown}};
    if(row.type==='compacted')native.sawCheckpoint=true;
    // Pinned 0.153.4 rejects task_failed as a fork cutoff (real synthetic
    // preflight r08). Parsed history can still preserve it; decide fallback
    // before creating a native worker, not after a failed provider operation.
    if(row.type==='event_msg'&&['task_complete','task_failed','turn_aborted'].includes(String(row.payload?.type))){
      // An older failure remains inherited history, not a permanent ban on
      // later supported cutoffs. Keep this bound to the same terminal digest.
      native.unsupportedCutoff=row.payload?.type==='task_failed';
      native.baseDigest=native.hash.copy().digest('hex');
    }
  };
  // The UI deliberately drops oversized rows and evicts dedupe keys. Neither
  // is a gap in the on-disk native source. Attest its byte stream separately,
  // retaining at most one incomplete line within the existing 8 MiB bound.
  // UI passes may reread an incomplete row; never hash those bytes twice.
  const consumeNative=(input:Buffer,inputStart:number)=>{
    if(native.invalid)return;
    const scanned=native.scannedThrough??0;
    if(inputStart>scanned||inputStart+input.length>8*1024*1024){
      native.invalid=true;native.pending=undefined;return;
    }
    if(inputStart+input.length<=scanned)return;
    const fresh=input.subarray(scanned-inputStart);
    const chunks=[...(native.pending?.chunks??[])];
    let pendingBytes=native.pending?.bytes??0,start=0;
    try{
      for(let end=fresh.indexOf(0x0a);end>=0;end=fresh.indexOf(0x0a,start)){
        const segment=fresh.subarray(start,end);
        const row=chunks.length?Buffer.concat([...chunks,segment],pendingBytes+segment.length):segment;
        const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(row)) as unknown;
        const object=payloadObject(raw);
        if(typeof object.type!=='string'||object.timestamp===undefined)throw new Error('invalid envelope');
        timestampMs(object.timestamp);
        const payload=payloadObject(object.payload),item=checkpointObject(payload.item)??{};
        if([object,payload,item].some(part=>['thread_id','threadId'].some(key=>Object.hasOwn(part,key)&&part[key]!==threadId)))throw new Error('foreign thread');
        if(object.type==='event_msg'&&item.type==='FunctionCallOutput'&&!validFunctionCallOutput(payload,item,threadId))throw new Error('invalid tool event');
        onEnvelope(raw,row,scanned+start-pendingBytes);
        chunks.length=0;pendingBytes=0;
        start=end+1;
      }
      if(start<fresh.length){const tail=Buffer.from(fresh.subarray(start));chunks.push(tail);pendingBytes+=tail.length;}
      native.pending=pendingBytes?{chunks,bytes:pendingBytes}:undefined;
      native.scannedThrough=inputStart+input.length;
    }catch{
      // Keep bounded UI projection available, but never attest malformed data.
      native.invalid=true;native.pending=undefined;
    }
  };
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
          historyTruncated,
          options: LEGACY_PARSE_OPTIONS,
          gaps: new Set()
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
        historyTruncated,
        options: LEGACY_PARSE_OPTIONS,
        gaps: new Set()
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
    consumeNative(chunk.subarray(0, read.bytesRead), chunkStart);
    consume(chunk.subarray(0, read.bytesRead), chunkStart);
    scanOffset = physicalStart + readTotal;
  }

  const partialLine = pending.byteLength > 0 || skippingOversized;
  if (!skippingOversized) scanOffset = offset;
  native.digest=native.hash.copy().digest('hex');
  return {
    native,
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

async function readSnapshotPage(
  state: SnapshotState,
  threadId: string,
  signal: AbortSignal
): Promise<HistorySnapshotPage> {
  if (state.closed) throw new LocalSessionSourceError("source_closed");
  checkCancelled(signal);
  if (state.nextOffset >= state.watermark && !state.checkpointRange) {
    return {
      records: [],
      nextOffset: state.watermark,
      done: true,
      coverage: {complete: state.gaps.size === 0, gaps: [...state.gaps]}
    };
  }

  let file: FileHandle | undefined;
  const records: ConversationRecord[] = [];
  const pageEnd = Math.min(state.watermark, state.nextOffset + SNAPSHOT_PAGE_BYTES);
  let readPosition = state.nextOffset;
  let pending = Buffer.alloc(0);
  let pendingStart = state.nextOffset;
  let skippingOversized = false;

  const consumeLine = (bytes: Buffer, offset: number): void => {
    try {
      const context: ParseContext = {
        threadId,
        offset,
        seen: state.seen,
        seenOrder: state.seenOrder,
        activeTurnId: state.activeTurnId,
        historyTruncated: false,
        options: state.currentTurnId===undefined?SNAPSHOT_PARSE_OPTIONS:{...SNAPSHOT_PARSE_OPTIONS,inferTurnId:true},
        gaps: state.gaps
      };
      const parsed = parseLine(context, bytes);
      state.activeTurnId = context.activeTurnId;
      records.push(...parsed);
      if(state.currentTurnId!==undefined&&parsed.some(record=>record.sourceScope!=='conversation'&&record.turnId!==state.currentTurnId)){
        state.gaps.add('unattributed_record');
      }
      if (parsed.some(record => record.turnId === null && record.sourceTurnId == null && record.sourceScope !== 'conversation')) state.gaps.add("unattributed_record");
    } catch {
      // Snapshot parsing is best-effort per record; malformed records remain visible
      // as a coverage gap while later readable records continue to stream.
      state.gaps.add("unreadable_record");
    }
  };

  const consume = (input: Buffer, inputStart: number): void => {
    let remaining = input;
    let remainingStart = inputStart;
    while (remaining.byteLength > 0) {
      if (skippingOversized) {
        const newline = remaining.indexOf(0x0a);
        if (newline < 0) return;
        state.nextOffset = remainingStart + newline + 1;
        skippingOversized = false;
        remaining = remaining.subarray(newline + 1);
        remainingStart = state.nextOffset;
        continue;
      }

      const newline = remaining.indexOf(0x0a);
      if (newline < 0) {
        if (pending.byteLength === 0) pendingStart = remainingStart;
        pending = Buffer.concat([pending, remaining]);
        if (pending.byteLength > SNAPSHOT_MAX_LINE_BYTES) {
          state.gaps.add("unreadable_record");
          pending = Buffer.alloc(0);
          skippingOversized = true;
        }
        return;
      }

      const line = Buffer.concat([pending, remaining.subarray(0, newline)]);
      const lineStart = pending.byteLength === 0 ? remainingStart : pendingStart;
      pending = Buffer.alloc(0);
      consumeLine(line, lineStart);
      state.nextOffset = lineStart + line.byteLength + 1;
      remaining = remaining.subarray(newline + 1);
      remainingStart = state.nextOffset;
    }
  };

  try {
    file = await open(state.path, "r");
    checkCancelled(signal);
    const startStats = await file.stat();
    if (!sameIdentity(state.identity, identityOf(startStats)) || startStats.size < state.watermark) {
      throw new LocalSessionSourceError("source_identity_mismatch");
    }
    assertSessionIdentity(await firstLine(file, signal), threadId);
    const actualPrefixValidation = await prefixValidation(file, state.prefixLength, signal);
    if (actualPrefixValidation !== state.prefixValidation) {
      throw new LocalSessionSourceError("source_identity_mismatch");
    }
    const actualValidation = await cursorValidation(file, state.nextOffset, signal);
    if (state.nextOffset > 0 && actualValidation !== state.validation) {
      throw new LocalSessionSourceError("source_identity_mismatch");
    }
    const validateCheckpoint=async()=>{
      const range=state.checkpointRange;
      if(range&&await completePrefixValidation(file!,range.end,signal,range.start)!==range.digest){
        throw new LocalSessionSourceError('source_identity_mismatch');
      }
    };
    await validateCheckpoint();

    while (readPosition < state.watermark) {
      checkCancelled(signal);
      if (readPosition >= pageEnd && pending.byteLength === 0 && !skippingOversized) break;
      const size = Math.min(64 * 1024, state.watermark - readPosition);
      const chunk = Buffer.allocUnsafe(size);
      const read = await file.read(chunk, 0, size, readPosition);
      if (read.bytesRead === 0) throw new LocalSessionSourceError("source_identity_mismatch");
      const chunkStart = readPosition;
      readPosition += read.bytesRead;
      consume(chunk.subarray(0, read.bytesRead), chunkStart);
    }

    if (readPosition >= state.watermark && (pending.byteLength > 0 || skippingOversized)) {
      state.gaps.add("unreadable_record");
      state.nextOffset = state.watermark;
      pending = Buffer.alloc(0);
      skippingOversized = false;
    }

    await validateCheckpoint();
    const endStats = await file.stat();
    if (!sameIdentity(state.identity, identityOf(endStats)) || endStats.size < state.watermark) {
      throw new LocalSessionSourceError("source_identity_mismatch");
    }
    state.validation = await cursorValidation(file, state.nextOffset, signal);
    return {
      records,
      nextOffset: state.nextOffset,
      done: state.nextOffset >= state.watermark,
      coverage: {complete: state.gaps.size === 0, gaps: [...state.gaps]}
    };
  } catch (error) {
    if (error instanceof LocalSessionSourceError) throw error;
    throw new LocalSessionSourceError(errorCode(error));
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function snapshotIdentity(threadId: string, path: string, identity: FileIdentity): string {
  return createHash("sha256")
    .update(`${threadId}\0${normalizedPath(path)}\0${identity.device}:${identity.inode}:${identity.birthtimeMs}`, "utf8")
    .digest("hex");
}

export function createLocalSessionReader({root}: {root: string}): {
  read(threadId: string, signal: AbortSignal, matchesTurn?:(turnId:string)=>boolean): Promise<ReadBatch>;
  snapshot(threadId: string, signal: AbortSignal): Promise<HistorySnapshot>;
  openNativeTurn(threadId:string,signal:AbortSignal):Promise<NativeTurnSource>;
  nativeSnapshot(threadId:string,signal:AbortSignal,destination:NativeSourceDestination):Promise<NativeSourceSnapshot>;
  remove(threadId: string): void;
  close(): Promise<void>;
} {
  const requestedRoot = resolve(root);
  const cursors = new Map<string, Cursor>();
  const locks = new Map<string, Promise<ReadBatch>>();
  const pendingReads = new Set<Promise<ReadBatch>>();
  const nativeFlights=new Map<AbortController,string>();
  const nativeOperations=new Set<Promise<unknown>>();
  const turnCaptures=new Map<string,Set<NativeTurnSource>>();
  const snapshotEpochs = new Map<string, {
    path: string;
    identity: FileIdentity;
    watermark: number;
    epoch: number;
    prefixValidation: string;
    checkpointFingerprint: string | undefined;
    prefixLength: number;
    startOffset: number;
  }>();
  let snapshotRevision = 0;
  let nativeEpoch=0;
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

  async function openNativeTurn(threadId:string,signal:AbortSignal):Promise<NativeTurnSource>{
    if(closed)throw new LocalSessionSourceError('source_closed');
    checkCancelled(signal);
    if(!UUID.test(threadId))throw new LocalSessionSourceError('source_invalid_thread');
    const observed=cursors.get(threadId),native=observed?.native,boundary=native?.index.snapshot();
    if(!observed||!native||!boundary||native.invalid||observed.skippingOversized||boundary.watermark!==observed.offset||
      boundary.currentTurnId!==observed.activeTurnId)throw new LocalSessionSourceError('source_unobserved');
    if(boundary.watermark>8*1024*1024)throw new LocalSessionSourceError('source_limit');
    if(native.sawCheckpoint&&boundary.completed===null)throw new LocalSessionSourceError('source_checkpoint_unsupported');
    if(native.unsupportedCutoff)throw new LocalSessionSourceError('source_terminal_unsupported');
    const candidate={path:observed.path,identity:{...observed.identity}},epoch=native.epoch,digest=native.digest;
    const baseDigest=native.baseDigest,revision=++snapshotRevision;
    const identity=snapshotIdentity(threadId,candidate.path,candidate.identity);
    const startOffset=boundary.completed?.endOffset??0;
    let sourceClosed=false,baseOpened=false,baseFlight:Promise<NativeSourceSnapshot|null>|undefined;
    const states=new Set<SnapshotState>();
    const assertBound=()=>{
      if(closed||sourceClosed)throw new LocalSessionSourceError('source_closed');
      const current=cursors.get(threadId);
      if(current!==observed||current.native?.epoch!==epoch||current.native.invalid||
        current.activeTurnId!==boundary.currentTurnId||current.offset<boundary.watermark){
        throw new LocalSessionSourceError('source_identity_mismatch');
      }
    };
    const validate=async(checkSignal:AbortSignal)=>{
      const combined=AbortSignal.any([signal,checkSignal]);checkCancelled(combined);assertBound();
      const located=await discover(threadId,combined);
      if(!samePath(candidate.path,located.path)||!sameIdentity(candidate.identity,located.identity))throw new LocalSessionSourceError('source_identity_mismatch');
      const file=await open(candidate.path,'r');
      try{
        const before=await file.stat();
        if(!sameIdentity(candidate.identity,identityOf(before))||before.size<boundary.watermark)throw new LocalSessionSourceError('source_identity_mismatch');
        assertSessionIdentity(await firstLine(file,combined),threadId);
        if(await completePrefixValidation(file,boundary.watermark,combined)!==digest){
          // Ensure the next UI read resets/rebuilds, even when only an early
          // byte outside its rolling validation window changed.
          if(cursors.get(threadId)===observed){observed.native!.invalid=true;observed.validation='native-content-changed';}
          throw new LocalSessionSourceError('source_identity_mismatch');
        }
        const after=await file.stat();
        if(!sameIdentity(candidate.identity,identityOf(after))||after.size<boundary.watermark)throw new LocalSessionSourceError('source_identity_mismatch');
        checkCancelled(combined);assertBound();
      }finally{await file.close();}
    };
    await validate(signal);
    const file=await open(candidate.path,'r');
    let startValidation:string,prefixDigest:string;
    const prefixLength=Math.min(4096,boundary.watermark);
    try{startValidation=await cursorValidation(file,startOffset,signal);prefixDigest=await prefixValidation(file,prefixLength,signal);}
    finally{await file.close();}
    await validate(signal);
    const supplement=createHistorySnapshot({identity,sourceEpoch:epoch,revision,startOffset,
      open:()=>{
        assertBound();
        const state:SnapshotState={path:candidate.path,identity:candidate.identity,watermark:boundary.watermark,
          nextOffset:startOffset,validation:startValidation,prefixValidation:prefixDigest,prefixLength,
          currentTurnId:boundary.currentTurnId,activeTurnId:null,seen:new Set(),seenOrder:[],gaps:new Set(),closed:false};
        states.add(state);
        return {readPage:async(offset,pageSignal)=>{
          if(offset!==state.nextOffset)throw new LocalSessionSourceError('source_identity_mismatch');
          await validate(pageSignal);
          const page=await readSnapshotPage(state,threadId,AbortSignal.any([signal,pageSignal]));
          await validate(pageSignal);return page;
        },close:async()=>{state.closed=true;states.delete(state);}};
      },close:async()=>{for(const state of states)state.closed=true;states.clear();}
    });
    const view:NativeTurnSource={identity,sourceEpoch:epoch,revision,currentTurnId:boundary.currentTurnId,
      boundary:{...boundary,completed:boundary.completed===null?null:{...boundary.completed}},
      baseKey:createHash('sha256').update(JSON.stringify([identity,epoch,boundary.currentTurnId,boundary.completed,baseDigest])).digest('hex'),
      supplement,validate,
      openBase(destination,baseSignal){
        if(baseOpened)return Promise.reject(new LocalSessionSourceError('source_unobserved'));
        baseOpened=true;
        baseFlight=(async()=>{
          await validate(baseSignal);
          if(boundary.completed===null)return null;
          if(!baseDigest)throw new LocalSessionSourceError('source_unobserved');
          const snapshot=await createNativeSourceSnapshot({...destination,sourcePath:candidate.path,sourceRoot:requestedRoot,
            sourceThreadId:threadId,sourceEpoch:epoch,revision,byteWatermark:boundary.completed.endOffset,signal:AbortSignal.any([signal,baseSignal])});
          try{
            const copy=await open(snapshot.path,'r');
            try{if(await completePrefixValidation(copy,snapshot.byteLength,baseSignal)!==baseDigest)throw new LocalSessionSourceError('source_identity_mismatch');}
            finally{await copy.close();}
            await validate(baseSignal);return {...snapshot,sourceTurnId:boundary.completed.turnId};
          }catch(error){await snapshot.close();throw error;}
        })();
        return baseFlight;
      },
      async close(){
        sourceClosed=true;await supplement.close();await baseFlight?.catch(()=>undefined);
        const owned=turnCaptures.get(threadId);owned?.delete(view);if(owned?.size===0)turnCaptures.delete(threadId);
      }
    };
    assertBound();
    const owned=turnCaptures.get(threadId)??new Set<NativeTurnSource>();owned.add(view);turnCaptures.set(threadId,owned);
    return view;
  }

  async function snapshotOne(threadId: string, signal: AbortSignal): Promise<HistorySnapshot> {
    if (closed) throw new LocalSessionSourceError("source_closed");
    checkCancelled(signal);
    if (!UUID.test(threadId)) throw new LocalSessionSourceError("source_invalid_thread");
    const candidate = await discover(threadId, signal);
    let file: FileHandle | undefined;
    try {
      file = await open(candidate.path, "r");
      checkCancelled(signal);
      const stats = await file.stat();
      if (!sameIdentity(candidate.identity, identityOf(stats))) {
        throw new LocalSessionSourceError("source_identity_mismatch");
      }
      assertSessionIdentity(await firstLine(file, signal), threadId);
      const identity = identityOf(stats);
      const checkpointScan = await scanLatestCheckpoint(file, stats.size, signal);
      const checkpoint = checkpointScan.checkpoint;
      const startOffset = checkpointScan.startOffset;
      const previous = snapshotEpochs.get(threadId);
      // Compare hashes over the same byte range, even while a small source grows.
      const prefixLength = Math.min(previous?.prefixLength ?? 4 * 1024, stats.size);
      const currentPrefixValidation = await prefixValidation(
        file,
        prefixLength,
        signal
      );
      const sameEpoch = previous !== undefined && samePath(previous.path, candidate.path) &&
        sameIdentity(previous.identity, identity) && stats.size >= previous.watermark &&
        previous.prefixValidation === currentPrefixValidation &&
        previous.checkpointFingerprint === checkpoint?.fingerprint &&
        previous.startOffset === startOffset;
      const epoch = sameEpoch ? previous.epoch : (previous?.epoch ?? 0) + 1;
      snapshotEpochs.set(threadId, {
        path: candidate.path,
        identity,
        watermark: stats.size,
        epoch,
        prefixValidation: currentPrefixValidation,
        prefixLength,
        checkpointFingerprint: checkpoint?.fingerprint,
        startOffset
      });
      const startValidation = startOffset > 0 ? await cursorValidation(file, startOffset, signal) : "";
      const states = new Set<SnapshotState>();
      let sourceClosed = false;
      return createHistorySnapshot({
        identity: snapshotIdentity(threadId, candidate.path, identity),
        sourceEpoch: epoch,
        revision: ++snapshotRevision,
        ...(checkpoint === undefined ? {} : {checkpoint, startOffset}),
        open: () => {
          if (sourceClosed) throw new LocalSessionSourceError("source_closed");
          const state: SnapshotState = {
            path: candidate.path,
            identity,
            ...(checkpointScan.checkpointRange?{checkpointRange:checkpointScan.checkpointRange}:{}),
            watermark: stats.size,
            nextOffset: startOffset,
            validation: startValidation,
            prefixValidation: currentPrefixValidation,
            prefixLength,
            activeTurnId: null,
            seen: new Set(),
            seenOrder: [],
            gaps: new Set(),
            closed: false
          };
          states.add(state);
          return {
            readPage: (offset: number, pageSignal: AbortSignal) => {
              if (offset !== state.nextOffset) {
                throw new LocalSessionSourceError("source_identity_mismatch");
              }
              return readSnapshotPage(state, threadId, pageSignal);
            },
            close: async () => {
              state.closed = true;
              states.delete(state);
            }
          };
        },
        close: async () => {
          sourceClosed = true;
          for (const state of states) state.closed = true;
          states.clear();
        }
      });
    } catch (error) {
      if (error instanceof LocalSessionSourceError) throw error;
      throw new LocalSessionSourceError(errorCode(error));
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  async function readOne(threadId: string, signal: AbortSignal, matchesTurn?:(turnId:string)=>boolean): Promise<ReadBatch> {
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
      if(!cursor.native)cursor.native={index:createNativeTurnIndex(),hash:createHash('sha256'),epoch:++nativeEpoch,
        digest:createHash('sha256').digest('hex'),baseDigest:null,sawCheckpoint:false,unsupportedCutoff:false,invalid:false};
      const registeredCursor=cursor;
      let bootstrapDigest:string|undefined;
      // Keep the existing full-file native path whenever its byte bound permits it.
      if(cursor.offset===0&&cursor.scanOffset===0&&matchesTurn&&stats.size>8*1024*1024){
        const start=await scanTurnStart(file,stats.size,signal,matchesTurn);
        if(start>0){
          bootstrapDigest=await completePrefixValidation(file,stats.size,signal,start);
          const validation=await cursorValidation(file,start,signal);
          // A skipped raw prefix must never produce a valid full-file fork hash.
          // Publish this cursor only after the complete first pass validates.
          cursor={...cursor,offset:start,scanOffset:start,projectionStart:start,validation,scanValidation:validation,
            native:{...cursor.native,invalid:true}};
        }
      }
      const result = await runPass(file, cursor, threadId, signal);
      if(bootstrapDigest!==undefined&&await completePrefixValidation(file,stats.size,signal,cursor.projectionStart)!==bootstrapDigest)
        throw new LocalSessionSourceError('source_identity_mismatch');
      assertSessionIdentity(await firstLine(file,signal),threadId);
      const endStats = await file.stat();
      checkCancelled(signal);
      if(cursors.get(threadId)!==registeredCursor)throw new LocalSessionSourceError('source_cancelled');
      if (!sameIdentity(cursor.identity, identityOf(endStats)) || endStats.size < result.scanOffset) {
        cursors.set(threadId, {path: candidate.path, identity: identityOf(endStats), size: 0, offset: 0,
          validation: "", seen: new Set(), seenOrder: [], activeTurnId: null, forceResetOnGrowth: true,
          scanOffset: 0, scanValidation: "", skippingOversized: false});
        return {records: [], caughtUp: false, reset: true, partialLine: false};
      }
      cursor.offset = result.offset;
      cursor.native = result.native;
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
      cursors.set(threadId,cursor);
      const batch: ReadBatch = {
        records: result.records,
        caughtUp: result.caughtUp,
        reset,
        partialLine: result.partialLine
      };
      if (result.historyTruncated || cursor.projectionStart!==undefined) batch.historyTruncated = true;
      return batch;
    } catch (error) {
      if (error instanceof LocalSessionSourceError) throw error;
      throw new LocalSessionSourceError(errorCode(error));
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  function read(threadId: string, signal: AbortSignal,matchesTurn?:(turnId:string)=>boolean): Promise<ReadBatch> {
    if(closed)return Promise.reject(new LocalSessionSourceError('source_closed'));
    if(signal.aborted)return Promise.reject(new LocalSessionSourceError('source_cancelled'));
    if(pendingReads.size>=4)return Promise.reject(new LocalSessionSourceError('source_limit'));
    const previous = locks.get(threadId);
    const current = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
      const batch=await readOne(threadId,signal,matchesTurn);checkCancelled(signal);return batch;
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
    snapshot: snapshotOne,
    openNativeTurn(threadId,signal){
      const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
      const operation=openNativeTurn(threadId,combined);
      nativeFlights.set(controller,threadId);nativeOperations.add(operation);
      void operation.finally(()=>{nativeFlights.delete(controller);nativeOperations.delete(operation);}).catch(()=>undefined);
      return operation;
    },
    nativeSnapshot(threadId,signal,destination){
      const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
      const operation=(async()=>{
        if(closed)throw new LocalSessionSourceError('source_closed');
        checkCancelled(combined);
        if(!UUID.test(threadId))throw new LocalSessionSourceError('source_invalid_thread');
        const observed=cursors.get(threadId);
        if(!observed||observed.activeTurnId===null||observed.offset<1||observed.skippingOversized)throw new LocalSessionSourceError('source_unobserved');
        const boundary={offset:observed.offset,turnId:observed.activeTurnId,identity:observed.identity,path:observed.path};
        const candidate=await discover(threadId,combined);
        if(!samePath(boundary.path,candidate.path)||!sameIdentity(boundary.identity,candidate.identity))throw new LocalSessionSourceError('source_identity_mismatch');
        const revision=++snapshotRevision;
        const snapshot=await createNativeSourceSnapshot({...destination,sourcePath:candidate.path,sourceRoot:requestedRoot,
          sourceThreadId:threadId,sourceEpoch:revision,revision,signal:combined,byteWatermark:boundary.offset});
        try{
          checkCancelled(combined);
          if(closed)throw new LocalSessionSourceError('source_closed');
          if(!sameIdentity(candidate.identity,identityOf(await lstat(candidate.path))))throw new LocalSessionSourceError('source_identity_mismatch');
          const current=cursors.get(threadId);
          if(!current||current.activeTurnId!==boundary.turnId||current.offset<boundary.offset||!sameIdentity(current.identity,boundary.identity))throw new LocalSessionSourceError('source_identity_mismatch');
          return {...snapshot,sourceTurnId:boundary.turnId};
        }catch(error){await snapshot.close();throw error;}
      })();
      nativeFlights.set(controller,threadId);nativeOperations.add(operation);
      void operation.finally(()=>{nativeFlights.delete(controller);nativeOperations.delete(operation);}).catch(()=>undefined);
      return operation;
    },
    remove(threadId: string): void {
      for(const [controller,id] of nativeFlights)if(id===threadId)controller.abort();
      for(const view of turnCaptures.get(threadId)??[])void view.close().catch(()=>undefined);
      cursors.delete(threadId);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for(const controller of nativeFlights.keys())controller.abort();
      await Promise.allSettled([...nativeOperations]);
      await Promise.allSettled([...turnCaptures.values()].flatMap(views=>[...views].map(view=>view.close())));
      await Promise.allSettled([...pendingReads]);
      locks.clear();
      cursors.clear();
    }
  };
}
