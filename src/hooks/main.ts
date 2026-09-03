import { loadOrCreateToken } from "../server/token-store.js";
import { defaultTokenPath } from "../server/paths.js";
import { normalizeHookInput, type HookResult } from "./adapter.js";
import { createDefaultHookClient, type HookEventClient } from "./client.js";
import type { HookEnvelope, HookName } from "./schema.js";

export const MAX_HOOK_INPUT_BYTES = 64 * 1024;
export const MAX_HOOK_STDERR_BYTES = 2 * 1024;
export const MAX_HOOK_TIMEOUT_MS = 3_000;
const DEFAULT_HOOK_TIMEOUT_MS = 2_500;

type HookInputSource = AsyncIterable<Uint8Array | string> & { destroy?: () => void };
type HookPost = (
  envelope: HookEnvelope,
  options: { signal: AbortSignal; timeoutMs: number }
) => Promise<void>;

export interface HookRuntimeDependencies {
  stdin?: HookInputSource;
  readToken?: () => Promise<string>;
  hmacKey?: string;
  postHook?: HookPost;
  now?: () => number;
  timeoutMs?: number;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
}

class HookInputTooLargeError extends Error {}
class HookTimeoutError extends Error {}

async function readBoundedJson(source: HookInputSource, signal: AbortSignal): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const cancel = () => source.destroy?.();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for await (const chunk of source) {
      if (signal.aborted) throw new HookTimeoutError();
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_HOOK_INPUT_BYTES) throw new HookInputTooLargeError();
      chunks.push(buffer);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const content = Buffer.concat(chunks).toString("utf8").trim();
  if (content.length === 0) throw new SyntaxError("empty Hook input");
  return JSON.parse(content);
}

async function withDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  signal: AbortSignal,
  controller: AbortController
): Promise<T> {
  const remaining = Math.max(0, deadlineMs - Date.now());
  if (remaining === 0) {
    controller.abort(new HookTimeoutError());
    throw new HookTimeoutError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new HookTimeoutError());
      reject(new HookTimeoutError());
    }, remaining);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void operation.catch(() => undefined);
    void signal;
  }
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_HOOK_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_HOOK_TIMEOUT_MS, Math.floor(value)));
}

function failureCategory(error: unknown): string {
  if (error instanceof HookInputTooLargeError) return "input_too_large";
  if (error instanceof SyntaxError) return "invalid_input";
  if (error instanceof HookTimeoutError) return "timeout";
  return "hud_unavailable";
}

function writeBoundedStderr(write: (value: string) => void, category: string): void {
  const value = `Codex Progress HUD Hook skipped: ${category}\n`.slice(0, MAX_HOOK_STDERR_BYTES);
  try { write(value); } catch { /* diagnostics cannot affect the Hook protocol */ }
}

async function executeHookEvent(
  hookName: HookName,
  dependencies: HookRuntimeDependencies,
  client: HookEventClient,
  deadlineMs: number,
  controller: AbortController
): Promise<HookResult> {
  const input = await withDeadline(
    readBoundedJson(dependencies.stdin ?? process.stdin, controller.signal),
    deadlineMs,
    controller.signal,
    controller
  );
  const hmacKey = dependencies.hmacKey ?? await withDeadline(
    (dependencies.readToken ?? (() => loadOrCreateToken(defaultTokenPath())))(),
    deadlineMs,
    controller.signal,
    controller
  );
  const normalized = normalizeHookInput(hookName, input, (dependencies.now ?? Date.now)(), hmacKey);
  try {
    await withDeadline(
      (dependencies.postHook ?? ((envelope, options) => client.post(envelope, options)))
        (normalized.envelope, {
          signal: controller.signal,
          timeoutMs: Math.max(0, deadlineMs - Date.now())
        }),
      deadlineMs,
      controller.signal,
      controller
    );
  } catch {
    // Hook failures are deliberately fail-open; the normalized context remains useful.
  }
  return normalized.result;
}

export async function runHookEvent(
  hookName: HookName,
  dependencies: HookRuntimeDependencies = {}
): Promise<void> {
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value));
  const controller = new AbortController();
  const deadlineMs = Date.now() + boundedTimeout(dependencies.timeoutMs);
  let result: HookResult = { continue: true };
  try {
    result = await executeHookEvent(
      hookName,
      dependencies,
      createDefaultHookClient(),
      deadlineMs,
      controller
    );
  } catch (error) {
    writeBoundedStderr(writeStderr, failureCategory(error));
  }
  try { writeStdout(`${JSON.stringify(result)}\n`); } catch { /* fail-open */ }
}
