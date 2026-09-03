import {
  createHookEnvelope,
  defaultHookHmacKey,
  hookResult,
  type HookResult
} from "./schema.js";
import type { HookEnvelope } from "./schema.js";

export type { HookResult };

/**
 * Normalize a Codex command Hook without carrying any content-bearing fields
 * across the Hook/companion boundary. The optional key is an injection seam
 * for tests; production callers pass the protected auth token loaded by the
 * Hook entry before invoking this function.
 */
export function normalizeHookInput(
  hookName: HookEnvelope["hook"],
  input: unknown,
  nowMs: number,
  hmacKey = defaultHookHmacKey()
): { envelope: HookEnvelope; result: HookResult } {
  const envelope = createHookEnvelope(hookName, input, nowMs, hmacKey);
  return { envelope, result: hookResult(hookName, envelope.taskHandle) };
}
