import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ProgressEnvelope } from "../core/schema.js";
import { PROTOCOL_VERSION, type HudHealth } from "../lifecycle/types.js";
import type { HudSnapshot } from "../server/task-store.js";
import { defaultServiceUrl, defaultTokenPath } from "../server/paths.js";

export interface HudRequestOptions {
  timeoutMs?: number;
  generation?: number;
  signal?: AbortSignal;
}

export interface ProgressClient {
  submit(envelope: ProgressEnvelope, options?: HudRequestOptions): Promise<ProgressClientSnapshot>;
  status(options?: HudRequestOptions): Promise<ProgressClientSnapshot>;
}

export interface ProgressClientSnapshot {
  task: { id?: string; title?: string; status: string } | null;
  eta: unknown;
}

export type HudClientErrorCode =
  | "OFFLINE"
  | "AUTH_ERROR"
  | "PORT_CONFLICT"
  | "VERSION_MISMATCH"
  | "GENERATION_REJECTED";

export class HudClientError extends Error {
  constructor(readonly code: HudClientErrorCode, message: string) {
    super(message);
    this.name = "HudClientError";
  }
}

const identitySchema = z.object({ service: z.string(), protocolVersion: z.number().int() }).strict();
const healthSchema = z.object({
  service: z.literal("codex-progress-hud"),
  pid: z.number().int().positive(),
  version: z.string().trim().min(1).max(256),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  instanceNonce: z.string().trim().min(1).max(256),
  startedAt: z.string(),
  visibility: z.enum(["visible", "hidden"])
}).strict();
const controlSchema = z.object({ accepted: z.literal(true) }).strict();

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
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

export class CompanionHttpClient implements ProgressClient {
  constructor(
    private readonly serviceUrl = defaultServiceUrl(),
    private readonly tokenPath = defaultTokenPath()
  ) {}

  async #token(): Promise<string> {
    try { return (await readFile(this.tokenPath, "utf8")).trim(); }
    catch { throw new HudClientError("AUTH_ERROR", "HUD authentication is unavailable"); }
  }

  async #request(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    options: HudRequestOptions
  ): Promise<{ response: Response; payload: unknown }> {
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 60_000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(`${this.serviceUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...init.headers,
          ...(authenticated ? { authorization: `Bearer ${await this.#token()}` } : {}),
          ...(options.generation === undefined
            ? {}
            : { "x-codex-progress-hud-generation": String(options.generation) })
        }
      });
      return { response, payload: await readBoundedJson(response, controller) };
    } catch (error) {
      if (error instanceof HudClientError || error instanceof InvalidResponseError) throw error;
      throw new HudClientError("OFFLINE", "Progress HUD is not reachable");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async #authenticatedJson(
    path: string,
    init: RequestInit = {},
    options: HudRequestOptions = {}
  ): Promise<unknown> {
    const result = await this.#request(path, init, true, options);
    if (result.response.status === 401) {
      throw new HudClientError("AUTH_ERROR", "HUD authentication was rejected");
    }
    if (result.response.status === 409) {
      throw new HudClientError("GENERATION_REJECTED", "HUD lifecycle generation was rejected");
    }
    if (!result.response.ok) {
      throw new HudClientError("VERSION_MISMATCH", "HUD endpoint response is incompatible");
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
    if (parsed.protocolVersion !== PROTOCOL_VERSION) {
      throw new HudClientError("VERSION_MISMATCH", "Progress HUD protocol is incompatible");
    }
    return { service: parsed.service, protocolVersion: PROTOCOL_VERSION };
  }

  async health(options: HudRequestOptions = {}): Promise<HudHealth> {
    try { return healthSchema.parse(await this.#authenticatedJson("/api/health", {}, options)); }
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
