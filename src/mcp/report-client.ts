import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ProgressEnvelope } from "../core/schema.js";
import { PROTOCOL_VERSION, type HudHealth } from "../lifecycle/types.js";
import type { HudSnapshot } from "../server/task-store.js";
import { defaultServiceUrl, defaultTokenPath } from "../server/paths.js";

export interface ProgressClient {
  submit(envelope: ProgressEnvelope): Promise<ProgressClientSnapshot>;
  status(): Promise<ProgressClientSnapshot>;
}

export interface ProgressClientSnapshot {
  task: { id?: string; title?: string; status: string } | null;
  eta: unknown;
}

export type HudClientErrorCode =
  | "OFFLINE"
  | "AUTH_ERROR"
  | "PORT_CONFLICT"
  | "VERSION_MISMATCH";

export class HudClientError extends Error {
  constructor(
    readonly code: HudClientErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HudClientError";
  }
}

const identitySchema = z
  .object({ service: z.string(), protocolVersion: z.number().int() })
  .strict();

const healthSchema = z
  .object({
    service: z.literal("codex-progress-hud"),
    pid: z.number().int().positive(),
    version: z.string(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    instanceNonce: z.string(),
    startedAt: z.string(),
    visibility: z.enum(["visible", "hidden"])
  })
  .strict();

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
    try {
      return (await readFile(this.tokenPath, "utf8")).trim();
    } catch {
      throw new HudClientError("AUTH_ERROR", "HUD authentication is unavailable");
    }
  }

  async #fetch(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.serviceUrl}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          ...(authenticated ? { authorization: `Bearer ${await this.#token()}` } : {})
        }
      });
    } catch (error) {
      if (error instanceof HudClientError) throw error;
      throw new HudClientError("OFFLINE", "Progress HUD is not reachable");
    }
    if (!response.ok) {
      const code = response.status === 401 ? "AUTH_ERROR" : "OFFLINE";
      throw new HudClientError(code, `HUD request failed with status ${response.status}`);
    }
    return response;
  }

  async identity(): Promise<HudIdentity> {
    let parsed: z.infer<typeof identitySchema>;
    try {
      parsed = identitySchema.parse(await (await this.#fetch("/health", {}, false)).json());
    } catch (error) {
      if (error instanceof HudClientError) throw error;
      throw new HudClientError("PORT_CONFLICT", "Listener is not the Progress HUD service");
    }
    if (parsed.service !== "codex-progress-hud") {
      throw new HudClientError("PORT_CONFLICT", "Listener is not the Progress HUD service");
    }
    if (parsed.protocolVersion !== PROTOCOL_VERSION) {
      throw new HudClientError("VERSION_MISMATCH", "Progress HUD protocol is incompatible");
    }
    return { service: parsed.service, protocolVersion: PROTOCOL_VERSION };
  }

  async health(): Promise<HudHealth> {
    try {
      return healthSchema.parse(await (await this.#fetch("/api/health")).json());
    } catch (error) {
      if (error instanceof HudClientError) throw error;
      throw new HudClientError("VERSION_MISMATCH", "Progress HUD health response is incompatible");
    }
  }

  async #control(path: string): Promise<void> {
    await this.#fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
  }

  show(): Promise<void> {
    return this.#control("/api/window/show");
  }

  hide(): Promise<void> {
    return this.#control("/api/window/hide");
  }

  shutdown(): Promise<void> {
    return this.#control("/api/shutdown");
  }

  async #snapshot(path: string, init: RequestInit = {}): Promise<HudSnapshot> {
    return (await (await this.#fetch(path, init)).json()) as HudSnapshot;
  }

  submit(envelope: ProgressEnvelope): Promise<HudSnapshot> {
    return this.#snapshot("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
  }

  status(): Promise<HudSnapshot> {
    return this.#snapshot("/api/snapshot");
  }
}

export { CompanionHttpClient as HttpProgressClient };
