import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PassiveContent } from './passive-content.js';

export const hookNames = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "Interrupt",
  "SessionEnd"
] as const;

export type HookName = (typeof hookNames)[number];
export type HookSource = "startup" | "resume" | "clear" | "compact";

const opaquePart = "[A-Za-z0-9_-]";
const taskHandleSchema = z.string().regex(new RegExp(`^hud_${opaquePart}{20,96}$`, "u"));
const eventIdSchema = z.string().regex(new RegExp(`^evt_${opaquePart}{20,128}$`, "u"));
const sessionKeySchema = z.string().regex(new RegExp(`^session_${opaquePart}{20,128}$`, "u"));
const turnKeySchema = z.string().regex(new RegExp(`^turn_${opaquePart}{20,128}$`, "u"));

export const hookEnvelopeSchema = z.object({
  schemaVersion: z.literal(2),
  taskHandle: taskHandleSchema,
  eventId: eventIdSchema,
  sessionKey: sessionKeySchema,
  turnKey: turnKeySchema.optional(),
  hostThreadId: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/u).optional(),
  hook: z.enum(hookNames),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
  receivedAt: z.number().int().nonnegative().safe(),
  toolExitCode: z.number().int().safe().refine(code => code !== 0).optional(),
  toolFailure:z.boolean().optional(),
  content: z.object({
    kind: z.enum(['user', 'assistant', 'tool']),
    text: z.string().min(1).max(4096),
    truncated: z.boolean()
  }).strict().optional()
}).strict().superRefine((value, context) => {
  if ((value.toolExitCode !== undefined||value.toolFailure!==undefined) && value.hook !== 'PostToolUse') {
    context.addIssue({code: 'custom', path: ['toolExitCode'], message: 'tool exit code requires PostToolUse'});
  }
  if (value.content === undefined) return;
  const expected = value.hook === 'UserPromptSubmit' ? 'user'
    : value.hook === 'Stop' ? 'assistant'
    : value.hook === 'PostToolUse' ? 'tool' : undefined;
  if (value.turnKey === undefined || value.content.kind !== expected) {
    context.addIssue({code: 'custom', path: ['content'], message: 'content requires a matching scoped hook'});
  }
});

export interface HookEnvelope {
  schemaVersion: 2;
  taskHandle: string;
  eventId: string;
  sessionKey: string;
  turnKey?: string;
  /** Local Hook-to-companion metadata only; never part of progress snapshots. */
  hostThreadId?: string;
  hook: HookName;
  source?: HookSource;
  receivedAt: number;
  /** Bounded structured PostToolUse metadata; never inferred from output text. */
  toolExitCode?: number;
  toolFailure?:boolean;
  /** Private Hook-to-companion content; never include in public progress snapshots. */
  content?: PassiveContent;
}

export interface HookResult {
  continue?: true;
}

export const hookInputSchema = z.object({
  session_id: z.string().trim().min(1).max(256),
  turn_id: z.string().trim().min(1).max(256).optional(),
  tool_use_id: z.string().trim().min(1).max(256).optional(),
  hook_event_name: z.string().trim().min(1).max(64).optional(),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional()
}).passthrough();

function opaqueKey(prefix: string, key: string, value: string): string {
  return `${prefix}${createHmac("sha256", key).update(value).digest("base64url")}`;
}

function structuredToolExitCode(hook: HookName, input: unknown): number|undefined {
  if (hook !== 'PostToolUse' || typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const response = (input as Record<string, unknown>).tool_response;
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return undefined;
  const code = (response as Record<string, unknown>).exit_code;
  return typeof code === 'number' && Number.isSafeInteger(code) && code !== 0 ? code : undefined;
}

export function createHookEnvelope(
  hook: HookName,
  input: unknown,
  nowMs: number,
  hmacKey: string
): HookEnvelope {
  if (typeof hmacKey !== "string" || hmacKey.length < 32) {
    throw new Error("Hook HMAC key is required");
  }
  const parsed = hookInputSchema.parse(input);
  if (parsed.hook_event_name !== undefined && parsed.hook_event_name !== hook) {
    throw new z.ZodError([{
      code: "custom",
      path: ["hook_event_name"],
      message: "hook event name does not match the selected hook"
    }]);
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError("Hook receipt time must be a nonnegative safe integer");
  }

  const sessionKey = opaqueKey("session_", hmacKey, parsed.session_id);
  const turnKey = parsed.turn_id === undefined
    ? undefined
    : opaqueKey("turn_", hmacKey, `${parsed.session_id}\u0000${parsed.turn_id}`);
  const taskHandle = opaqueKey("hud_", hmacKey, parsed.turn_id === undefined
    ? `unscoped-session\u0000${parsed.session_id}`
    : `turn-task\u0000${parsed.session_id}\u0000${parsed.turn_id}`);
  const toolExitCode = structuredToolExitCode(hook, parsed);
  const toolResponse=parsed.tool_response;
  const toolFailure=hook==='PostToolUse'&&toolResponse!==null&&typeof toolResponse==='object'&&!Array.isArray(toolResponse)&&
    Reflect.get(toolResponse,'is_error')===true;
  const eventId = opaqueKey(
    "evt_",
    hmacKey,
    [
      "hook-event",
      parsed.session_id,
      parsed.turn_id ?? "",
      hook,
      parsed.source ?? "",
      parsed.tool_use_id ?? "",
      parsed.turn_id === undefined ? randomUUID() : ""
    ].join("\u0000")
  );
  return hookEnvelopeSchema.parse({
    schemaVersion: 2,
    taskHandle,
    eventId,
    sessionKey,
    ...(turnKey === undefined ? {} : { turnKey }),
    hook,
    ...(parsed.source === undefined ? {} : { source: parsed.source }),
    receivedAt: nowMs,
    ...(toolExitCode === undefined ? {} : {toolExitCode}),...(toolFailure?{toolFailure:true}:{})
  }) as HookEnvelope;
}

export function hookResult(hook: HookName): HookResult {
  return hook === 'Interrupt' ? {} : {continue: true};
}

export function normalizeHookInput(
  hook: HookName,
  input: unknown,
  nowMs: number,
  hmacKey: string
): { envelope: HookEnvelope; result: HookResult } {
  const envelope = createHookEnvelope(hook, input, nowMs, hmacKey);
  return { envelope, result: hookResult(hook) };
}

export function parseHookEnvelope(value: unknown): HookEnvelope {
  return hookEnvelopeSchema.parse(value) as HookEnvelope;
}
