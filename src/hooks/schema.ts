import { createHash } from "node:crypto";
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
  continue: true;
  additionalContext?: string;
}

const hookInputSchema = z.object({
  session_id: z.string().trim().min(1).max(256),
  turn_id: z.string().trim().min(1).max(256).optional(),
  hook_event_name: z.string().trim().min(1).max(64).optional(),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional()
}).passthrough();

function opaqueKey(prefix: string, value: string): string {
  return `${prefix}${createHash("sha256").update(value).digest("base64url")}`;
}

export function normalizeHookInput(
  hook: HookName,
  input: unknown,
  nowMs: number
): { envelope: HookEnvelope; result: HookResult } {
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

  const sessionKey = opaqueKey("session_", parsed.session_id);
  const turnKey = parsed.turn_id === undefined
    ? undefined
    : opaqueKey("turn_", `${parsed.session_id}\u0000${parsed.turn_id}`);
  const taskHandle = opaqueKey("hud_", parsed.session_id);
  const eventId = opaqueKey(
    "evt_",
    [parsed.session_id, parsed.turn_id ?? "", hook, parsed.source ?? ""].join("\u0000")
  );
  const envelope = hookEnvelopeSchema.parse({
    schemaVersion: 1,
    taskHandle,
    eventId,
    sessionKey,
    ...(turnKey === undefined ? {} : { turnKey }),
    hook,
    ...(parsed.source === undefined ? {} : { source: parsed.source }),
    receivedAt: nowMs
  }) as HookEnvelope;
  const result: HookResult = { continue: true };
  if (hook === "SessionStart" || hook === "UserPromptSubmit") {
    result.additionalContext = `Use HUD task handle ${taskHandle} for this session's progress tools.`;
  }
  return { envelope, result };
}

export function parseHookEnvelope(value: unknown): HookEnvelope {
  return hookEnvelopeSchema.parse(value) as HookEnvelope;
}
