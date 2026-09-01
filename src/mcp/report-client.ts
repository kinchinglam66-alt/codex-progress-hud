import { readFile } from "node:fs/promises";
import type { ProgressEnvelope } from "../core/schema.js";
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

export class HttpProgressClient implements ProgressClient {
  constructor(
    private readonly serviceUrl = defaultServiceUrl(),
    private readonly tokenPath = defaultTokenPath()
  ) {}

  async #token(): Promise<string> {
    return (await readFile(this.tokenPath, "utf8")).trim();
  }

  async #request(path: string, init: RequestInit = {}): Promise<HudSnapshot> {
    const response = await fetch(`${this.serviceUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${await this.#token()}`
      }
    });
    if (!response.ok) throw new Error(`HUD request failed with status ${response.status}`);
    return (await response.json()) as HudSnapshot;
  }

  submit(envelope: ProgressEnvelope): Promise<HudSnapshot> {
    return this.#request("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
  }

  status(): Promise<HudSnapshot> {
    return this.#request("/api/snapshot");
  }
}
