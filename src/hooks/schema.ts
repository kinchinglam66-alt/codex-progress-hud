import { createHmac } from "node:crypto";
import { z } from "zod";

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
  schemaVersion: z.literal(1),
  taskHandle: taskHandleSchema,
  eventId: eventIdSchema,
  sessionKey: sessionKeySchema,
  turnKey: turnKeySchema.optional(),
  hook: z.enum(hookNames),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
  receivedAt: z.number().int().nonnegative().safe()
}).strict();

export interface HookEnvelope {
  schemaVersion: 1;
  taskHandle: string;
  eventId: string;
  sessionKey: string;
  turnKey?: string;
  hook: HookName;
  source?: HookSource;
  receivedAt: number;
}

export interface HookResult {
  continue?: true;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "SessionStart" | "UserPromptSubmit";
    additionalContext: string;
  };
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
  const taskHandle = opaqueKey("hud_", hmacKey, parsed.session_id);
  const eventId = opaqueKey(
    "evt_",
    hmacKey,
    [
      parsed.session_id,
      parsed.turn_id ?? "",
      hook,
      parsed.source ?? "",
      parsed.tool_use_id ?? ""
    ].join("\u0000")
  );
  return hookEnvelopeSchema.parse({
    schemaVersion: 1,
    taskHandle,
    eventId,
    sessionKey,
    ...(turnKey === undefined ? {} : { turnKey }),
    hook,
    ...(parsed.source === undefined ? {} : { source: parsed.source }),
    receivedAt: nowMs
  }) as HookEnvelope;
}

export function hookResult(hook: HookName, taskHandle: string): HookResult {
  if (hook === "Interrupt") return {};
  const result: HookResult = { continue: true };
  if (hook === "SessionStart" || hook === "UserPromptSubmit") {
    result.hookSpecificOutput = {
      hookEventName: hook,
      additionalContext: `Use HUD task handle ${taskHandle} with Progress HUD tools for this session.`
    };
  }
  return result;
}

export function normalizeHookInput(
  hook: HookName,
  input: unknown,
  nowMs: number,
  hmacKey: string
): { envelope: HookEnvelope; result: HookResult } {
  const envelope = createHookEnvelope(hook, input, nowMs, hmacKey);
  return { envelope, result: hookResult(hook, envelope.taskHandle) };
}

export function parseHookEnvelope(value: unknown): HookEnvelope {
  return hookEnvelopeSchema.parse(value) as HookEnvelope;
}
