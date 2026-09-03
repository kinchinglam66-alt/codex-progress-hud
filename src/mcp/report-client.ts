import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ProgressEnvelope } from "../core/schema.js";
import { RELEASE_CAPABILITIES, acceptsClientProtocol } from "../generated/capabilities.js";
import { type HudCapabilities, PROTOCOL_VERSION, type HudHealth } from "../lifecycle/types.js";
import type { HudSnapshot } from "../server/task-store.js";
import { defaultServiceUrl, defaultTokenPath } from "../server/paths.js";

export interface HudRequestOptions {
  timeoutMs?: number;
  generation?: number;
  clientProtocol?: number;
  signal?: AbortSignal;
}

export interface ProgressClient {
  submit(envelope: ProgressEnvelope, options?: HudRequestOptions): Promise<ProgressClientSnapshot>;
  status(options?: HudRequestOptions): Promise<ProgressClientSnapshot>;
}

interface LegacyProgressClientSnapshot {
  task: { id?: string; title?: string; status: string } | null;
  eta: unknown;
}

export type ProgressClientSnapshot = HudSnapshot | LegacyProgressClientSnapshot;

const HUD_CLIENT_ERROR_CODES = [
  "COMPANION_NOT_INSTALLED", "OFFLINE", "VERSION_MISMATCH", "GENERATION_REJECTED",
  "AUTH_ERROR", "START_TIMEOUT", "REQUEST_TIMEOUT", "REQUEST_CANCELLED",
  "PORT_CONFLICT", "SHUTTING_DOWN", "INTERNAL_ERROR"
] as const;
const clientErrorCodeSchema = z.enum(HUD_CLIENT_ERROR_CODES);
export type HudClientErrorCode = z.infer<typeof clientErrorCodeSchema>;

export class HudClientError extends Error {
  constructor(readonly code: HudClientErrorCode, message: string) {
    super(message);
    this.name = "HudClientError";
  }
}

const identitySchema = z.object({ service: z.string(), protocolVersion: z.number().int() }).strict();
const capabilitiesSchema = z.object({
  service: z.literal("codex-progress-hud"),
  companionVersion: z.string().trim().min(1).max(256),
  protocol: z.object({
    current: z.number().int().nonnegative(),
    minimumClient: z.number().int().nonnegative(),
    maximumClient: z.number().int().nonnegative()
  }).strict(),
  incompatibleClientSeen: z.boolean()
}).strict();
const healthSchema = z.object({
  service: z.literal("codex-progress-hud"),
  pid: z.number().int().positive(),
  version: z.string().trim().min(1).max(256),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  instanceNonce: z.string().trim().min(1).max(256),
  startedAt: z.string(),
  visibility: z.enum(["visible", "hidden"]),
  capabilities: capabilitiesSchema.optional()
}).strict();
const controlSchema = z.object({ accepted: z.literal(true) }).strict();

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const REQUEST_DEADLINE_HEADER = "x-codex-progress-hud-deadline-ms";
const REQUEST_PROTOCOL_HEADER = "x-codex-progress-hud-protocol";
class InvalidResponseError extends Error {}

async function readBoundedJson(response: Response, controller: AbortController): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new InvalidResponseError("HUD response body is unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new InvalidResponseError("HUD response exceeds the size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try { return JSON.parse(content); }
  catch { throw new InvalidResponseError("HUD response is not valid JSON"); }
}

export interface HudIdentity {
  service: "codex-progress-hud";
  protocolVersion: typeof PROTOCOL_VERSION;
}

type TokenReader = (
  path: string,
  options: { encoding: "utf8"; signal: AbortSignal }
) => Promise<string>;

export class CompanionHttpClient implements ProgressClient {
  constructor(
    private readonly serviceUrl = defaultServiceUrl(),
    private readonly tokenPath = defaultTokenPath(),
    private readonly readToken: TokenReader = (path, options) => readFile(path, options)
  ) {}

  async #token(signal: AbortSignal): Promise<string> {
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error("HUD authentication was cancelled"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return (await Promise.race([
        this.readToken(this.tokenPath, { encoding: "utf8", signal }),
        aborted
      ])).trim();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new HudClientError("AUTH_ERROR", "HUD authentication is unavailable");
    } finally {
      if (abort !== undefined) signal.removeEventListener("abort", abort);
    }
  }

  async #request(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    options: HudRequestOptions
  ): Promise<{ response: Response; payload: unknown }> {
    const controller = new AbortController();
    const requestedTimeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const boundedTimeoutMs = Math.max(0, Math.min(requestedTimeoutMs, 60_000));
    const timeoutMs = Number.isFinite(boundedTimeoutMs)
      ? Math.floor(boundedTimeoutMs)
      : 0;
    const deadlineMs = Date.now() + timeoutMs;
    let abortCause: "deadline" | "external" | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const claimAbortCause = (cause: "deadline" | "external") => {
      if (abortCause === undefined) {
        abortCause = cause;
        controller.abort();
      }
    };
    const abort = () => claimAbortCause("external");
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs === 0) {
      claimAbortCause("deadline");
    } else {
      timer = setTimeout(() => claimAbortCause("deadline"), timeoutMs);
      timer.unref();
    }
    try {
      const response = await fetch(`${this.serviceUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...init.headers,
          ...(authenticated
            ? {
                authorization: `Bearer ${await this.#token(controller.signal)}`,
                [REQUEST_DEADLINE_HEADER]: String(deadlineMs)
              }
            : {}),
          ...(options.generation === undefined
            ? {}
            : { "x-codex-progress-hud-generation": String(options.generation) }),
          ...(init.method?.toUpperCase() === "POST"
            ? {
                [REQUEST_PROTOCOL_HEADER]: String(
                  options.clientProtocol ?? RELEASE_CAPABILITIES.protocol.current
                )
              }
            : {})
        }
      });
      return { response, payload: await readBoundedJson(response, controller) };
    } catch (error) {
      if (abortCause === "deadline") {
        throw new HudClientError("REQUEST_TIMEOUT", "Progress HUD request timed out");
      }
      if (abortCause === "external") {
        throw new HudClientError("REQUEST_CANCELLED", "Progress HUD request was cancelled");
      }
      if (error instanceof HudClientError || error instanceof InvalidResponseError) throw error;
      throw new HudClientError("OFFLINE", "Progress HUD is not reachable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async #authenticatedJson(
    path: string,
    init: RequestInit = {},
    options: HudRequestOptions = {}
  ): Promise<unknown> {
    const result = await this.#request(path, init, true, options);
    const structuredCode = z.object({ code: clientErrorCodeSchema })
      .passthrough()
      .safeParse(result.payload);
    if (structuredCode.success) {
      throw new HudClientError(structuredCode.data.code, "Progress HUD request was rejected");
    }
    if (result.response.status === 401) {
      throw new HudClientError("AUTH_ERROR", "HUD authentication was rejected");
    }
    if (result.response.status === 409) {
      throw new HudClientError("GENERATION_REJECTED", "HUD lifecycle generation was rejected");
    }
    if (result.response.status === 423) {
      throw new HudClientError("SHUTTING_DOWN", "Progress HUD is shutting down");
    }
    if (result.response.status === 408) {
      throw new HudClientError("REQUEST_TIMEOUT", "Progress HUD request timed out");
    }
    if (!result.response.ok) {
      throw new HudClientError("INTERNAL_ERROR", "HUD endpoint returned an unexpected error");
    }
    return result.payload;
  }

  async identity(options: HudRequestOptions = {}): Promise<HudIdentity> {
    let result: { response: Response; payload: unknown };
    try { result = await this.#request("/health", {}, false, options); }
    catch (error) {
      if (error instanceof HudClientError) throw error;
      throw new HudClientError("PORT_CONFLICT", "Listener is not the Progress HUD service");
    }
    if (!result.response.ok) {
      throw new HudClientError("PORT_CONFLICT", "Listener is not the Progress HUD service");
    }
    let parsed: z.infer<typeof identitySchema>;
    try { parsed = identitySchema.parse(result.payload); }
    catch { throw new HudClientError("PORT_CONFLICT", "Listener is not the Progress HUD service"); }
    if (parsed.service !== "codex-progress-hud") {
      throw new HudClientError("PORT_CONFLICT", "Listener is not the Progress HUD service");
    }
    if (!acceptsClientProtocol(parsed.protocolVersion)) {
      throw new HudClientError("VERSION_MISMATCH", "Progress HUD protocol is incompatible");
    }
    return { service: parsed.service, protocolVersion: PROTOCOL_VERSION };
  }

  async health(options: HudRequestOptions = {}): Promise<HudHealth> {
    try {
      const health = healthSchema.parse(await this.#authenticatedJson("/api/health", {}, options));
      const capabilities = health.capabilities as HudCapabilities | undefined;
      if (capabilities !== undefined && (
        RELEASE_CAPABILITIES.protocol.current < capabilities.protocol.minimumClient ||
        RELEASE_CAPABILITIES.protocol.current > capabilities.protocol.maximumClient
      )) {
        throw new HudClientError("VERSION_MISMATCH", "Progress HUD protocol is incompatible");
      }
      const { capabilities: _capabilities, ...runtimeHealth } = health;
      return runtimeHealth;
    }
    catch (error) {
      if (error instanceof HudClientError) throw error;
      throw new HudClientError("VERSION_MISMATCH", "Progress HUD health response is incompatible");
    }
  }

  async #control(path: string, options: HudRequestOptions = {}): Promise<void> {
    try {
      controlSchema.parse(await this.#authenticatedJson(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }, options));
    } catch (error) {
      if (error instanceof HudClientError) throw error;
      throw new HudClientError("VERSION_MISMATCH", "HUD control response is incompatible");
    }
  }

  show(options?: HudRequestOptions): Promise<void> { return this.#control("/api/window/show", options); }
  hide(options?: HudRequestOptions): Promise<void> { return this.#control("/api/window/hide", options); }
  shutdown(options?: HudRequestOptions): Promise<void> { return this.#control("/api/shutdown", options); }

  async #snapshot(path: string, init: RequestInit = {}, options: HudRequestOptions = {}): Promise<HudSnapshot> {
    return await this.#authenticatedJson(path, init, options) as HudSnapshot;
  }

  submit(envelope: ProgressEnvelope, options?: HudRequestOptions): Promise<HudSnapshot> {
    return this.#snapshot("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope)
    }, options);
  }

  status(options?: HudRequestOptions): Promise<HudSnapshot> {
    return this.#snapshot("/api/snapshot", {}, options);
  }
}

export { CompanionHttpClient as HttpProgressClient };
