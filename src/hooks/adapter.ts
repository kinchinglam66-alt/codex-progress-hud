import {
  createHookEnvelope,
  hookResult,
  type HookResult
} from "./schema.js";
import type { HookEnvelope } from "./schema.js";

export type { HookResult };

/**
 * Normalize a Codex command Hook without carrying any content-bearing fields
 * across the Hook/companion boundary. Production callers pass the protected
 * auth token loaded by the Hook entry before invoking this function.
 */
export function normalizeHookInput(
  hookName: HookEnvelope["hook"],
  input: unknown,
  nowMs: number,
  hmacKey: string
): { envelope: HookEnvelope; result: HookResult } {
  const envelope = createHookEnvelope(hookName, input, nowMs, hmacKey);
  return { envelope, result: hookResult(hookName) };
}
