import { loadOrCreateToken } from "../server/token-store.js";
import { defaultTokenPath } from "../server/paths.js";
import { normalizeHookInput, type HookResult } from "./adapter.js";
import { createDefaultHookClient, HookDeliveryError, type HookEventClient } from "./client.js";
import { HudClientError } from "../mcp/report-client.js";
import { hookNames, type HookEnvelope, type HookName } from "./schema.js";
import { hookInputSchema } from './schema.js';
import { extractPassiveContent } from './passive-content.js';
import { performance } from "node:perf_hooks";

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

type HookStage = "input" | "token" | "normalize" | "delivery";
interface HookDiagnosticContext { stage: HookStage; startedAt: number; }

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

function writeBoundedStderr(
  write: (value: string) => void,
  hookName: HookName,
  context: HookDiagnosticContext,
  category: string
): void {
  const hook = (hookNames as readonly string[]).includes(hookName) ? hookName : "unknown";
  const elapsedMs = Math.min(MAX_HOOK_TIMEOUT_MS, Math.max(0, Math.round(performance.now() - context.startedAt)));
  const fields = JSON.stringify({ hook, stage: context.stage, elapsedMs, category });
  const value = `Codex Progress HUD Hook skipped: ${category} ${fields}\n`.slice(0, MAX_HOOK_STDERR_BYTES);
  try { write(value); } catch { /* diagnostics cannot affect the Hook protocol */ }
}

function enterStage(context: HookDiagnosticContext, stage: HookStage): void {
  context.stage = stage;
  context.startedAt = performance.now();
}

function deliveryFailureCategory(error: unknown): string {
  if (error instanceof HookTimeoutError) return "delivery_timeout";
  if (error instanceof HookDeliveryError || error instanceof HudClientError) {
    switch (error.code) {
      case "START_TIMEOUT": return "delivery_start_timeout";
      case "AUTH_ERROR": return "delivery_auth_error";
      case "OFFLINE": return "delivery_offline";
      case "REQUEST_TIMEOUT": return "delivery_timeout";
      case "REQUEST_CANCELLED": return "delivery_cancelled";
      case "MANUALLY_DISABLED": return "delivery_disabled";
      case "VERSION_MISMATCH": return "delivery_version_mismatch";
      case "PORT_CONFLICT": return "delivery_port_conflict";
      default: return "delivery_unavailable";
    }
  }
  return "delivery_unavailable";
}

async function executeHookEvent(
  hookName: HookName,
  dependencies: HookRuntimeDependencies,
  client: HookEventClient,
  deadlineMs: number,
  controller: AbortController,
  diagnostic: HookDiagnosticContext
): Promise<HookResult> {
  enterStage(diagnostic, "input");
  const input = await withDeadline(
    readBoundedJson(dependencies.stdin ?? process.stdin, controller.signal),
    deadlineMs,
    controller.signal,
    controller
  );
  enterStage(diagnostic, "token");
  const hmacKey = dependencies.hmacKey ?? await withDeadline(
    (dependencies.readToken ?? (() => loadOrCreateToken(defaultTokenPath())))(),
    deadlineMs,
    controller.signal,
    controller
  );
  enterStage(diagnostic, "normalize");
  const normalized = normalizeHookInput(hookName, input, (dependencies.now ?? Date.now)(), hmacKey);
  const content = normalized.envelope.turnKey === undefined ? null : extractPassiveContent(hookName, input);
  if (content !== null && content.text.length > 0) normalized.envelope.content = content;
  const envelope: HookEnvelope = (hookName==='SessionStart'||hookName==='UserPromptSubmit'||
    (normalized.envelope.turnKey!==undefined&&hookName==='PostToolUse'))
    ? {...normalized.envelope,hostThreadId:hookInputSchema.parse(input).session_id}
    : normalized.envelope;
  enterStage(diagnostic, "delivery");
  try {
    await withDeadline(
      (dependencies.postHook ?? ((envelope, options) => client.post(envelope, options)))
        (envelope, {
          signal: controller.signal,
          timeoutMs: Math.max(0, deadlineMs - Date.now())
        }),
      deadlineMs,
      controller.signal,
      controller
    );
  } catch (error) {
    // Delivery failures must not block execution or inject instructions into it.
    writeBoundedStderr(
      dependencies.writeStderr ?? ((value: string) => process.stderr.write(value)),
      hookName,
      diagnostic,
      deliveryFailureCategory(error)
    );
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
  const diagnostic: HookDiagnosticContext = { stage: "input", startedAt: performance.now() };
  let result: HookResult = hookName === "Interrupt" ? {} : { continue: true };
  try {
    result = await executeHookEvent(
      hookName,
      dependencies,
      createDefaultHookClient(),
      deadlineMs,
      controller,
      diagnostic
    );
  } catch (error) {
    writeBoundedStderr(writeStderr, hookName, diagnostic, failureCategory(error));
  }
  try { writeStdout(`${JSON.stringify(result)}\n`); } catch { /* fail-open */ }
}
