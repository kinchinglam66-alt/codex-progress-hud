import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";
import { parseProgressEnvelope } from "../core/schema.js";
import { PROTOCOL_VERSION, type HudHealth } from "../lifecycle/types.js";
import type { DesiredHudState } from "../lifecycle/types.js";
import { loadOrCreateToken, tokensEqual } from "./token-store.js";
import { TaskStore, type HudSnapshot } from "./task-store.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface ProgressServerControls {
  health(): HudHealth;
  showWindow(): void | Promise<void>;
  hideWindow(): void | Promise<void>;
  requestShutdown(): void | Promise<void>;
}

export interface ProgressServerOptions extends Partial<ProgressServerControls> {
  host?: string;
  port?: number;
  tokenPath: string;
  uiDirectory?: string;
  runIfGeneration?(
    generation: number,
    desiredState: DesiredHudState,
    operation: () => unknown | Promise<unknown>
  ): Promise<{ accepted: false } | { accepted: true; value: unknown }>;
}

export interface ProgressServerAddress {
  host: string;
  port: number;
  url: string;
}

class BodyTooLargeError extends Error {}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

async function serveUi(
  response: ServerResponse,
  uiDirectory: string,
  pathname: string
): Promise<boolean> {
  const assets: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/renderer.js": { file: "renderer.js", type: "text/javascript; charset=utf-8" }
  };
  const asset = assets[pathname];
  if (asset === undefined) return false;
  try {
    const content = await readFile(join(uiDirectory, asset.file));
    response.writeHead(200, {
      "content-type": asset.type,
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    });
    response.end(content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError("request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readEmptyJson(request: IncomingMessage): Promise<void> {
  const payload = await readJson(request);
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 0
  ) {
    throw new SyntaxError("control payload must be an empty JSON object");
  }
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function hasJsonMediaType(request: IncomingMessage): boolean {
  const mediaType = (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim();
  return mediaType?.toLowerCase() === "application/json";
}

export function createProgressServer(options: ProgressServerOptions) {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 17_837;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Codex Progress HUD only permits loopback listeners");
  }

  const store = new TaskStore();
  const tokenPromise = loadOrCreateToken(options.tokenPath);
  let server: Server | undefined;
  let currentAddress: ProgressServerAddress | undefined;
  let shuttingDown = false;

  function requestGeneration(request: IncomingMessage): number | undefined {
    const header = request.headers["x-codex-progress-hud-generation"];
    if (typeof header !== "string" || !/^\d+$/u.test(header)) return undefined;
    const generation = Number(header);
    return Number.isSafeInteger(generation) ? generation : undefined;
  }

  async function runMutation(
    request: IncomingMessage,
    desiredState: DesiredHudState,
    operation: () => unknown | Promise<unknown>
  ): Promise<{ accepted: false } | { accepted: true; value: unknown }> {
    if (shuttingDown) return { accepted: false };
    if (options.runIfGeneration === undefined) {
      return { accepted: true, value: await operation() };
    }
    const generation = requestGeneration(request);
    if (generation === undefined) return { accepted: false };
    return options.runIfGeneration(generation, desiredState, operation);
  }

  async function handleSse(response: ServerResponse, token: string): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff"
    });
    const send = (snapshot: HudSnapshot) => response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    send(store.snapshot());
    store.on("changed", send);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    response.once("close", () => {
      clearInterval(heartbeat);
      store.off("changed", send);
    });
    void token;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          service: "codex-progress-hud",
          protocolVersion: PROTOCOL_VERSION
        });
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        if (
          request.method === "GET" &&
          options.uiDirectory !== undefined &&
          (await serveUi(response, options.uiDirectory, url.pathname))
        ) {
          return;
        }
        writeJson(response, 404, { error: "not found" });
        return;
      }

      const expectedToken = await tokenPromise;
      if (!tokensEqual(expectedToken, bearerToken(request))) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        writeJson(response, 200, store.snapshot());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        if (options.health === undefined) throw new Error("health callback is unavailable");
        writeJson(response, 200, options.health());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        await handleSse(response, expectedToken);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/events") {
        if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        const envelope = parseProgressEnvelope(await readJson(request));
        const result = await runMutation(request, "on", () => store.apply(envelope));
        if (!result.accepted) {
          writeJson(response, 409, { error: "lifecycle generation rejected" });
          return;
        }
        writeJson(response, 202, result.value);
        return;
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/api/window/show" ||
          url.pathname === "/api/window/hide" ||
          url.pathname === "/api/shutdown")
      ) {
        if (!hasJsonMediaType(request)) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        await readEmptyJson(request);
        const callback =
          url.pathname === "/api/window/show"
            ? options.showWindow
            : url.pathname === "/api/window/hide"
              ? options.hideWindow
              : options.requestShutdown;
        if (callback === undefined) throw new Error("control callback is unavailable");
        const desiredState = url.pathname === "/api/shutdown" ? "off" : "on";
        const result = await runMutation(request, desiredState, async () => {
          if (url.pathname === "/api/shutdown") shuttingDown = true;
          await callback();
        });
        if (!result.accepted) {
          writeJson(response, 409, { error: "lifecycle generation rejected" });
          return;
        }
        writeJson(response, 202, { accepted: true });
        return;
      }
      writeJson(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        writeJson(response, 413, { error: error.message });
      } else if (error instanceof SyntaxError || error instanceof ZodError) {
        writeJson(response, 400, { error: "invalid request payload" });
      } else {
        writeJson(response, 500, { error: "internal server error" });
      }
    }
  }

  return {
    store,
    async listen(): Promise<void> {
      await tokenPromise;
      if (server !== undefined) return;
      server = createServer((request, response) => void handle(request, response));
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(requestedPort, host, () => resolve());
      });
      const bound = server.address();
      if (bound === null || typeof bound === "string") throw new Error("unexpected server address");
      currentAddress = { host, port: bound.port, url: `http://${host}:${bound.port}` };
    },
    async close(): Promise<void> {
      if (server === undefined) return;
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error === undefined ? resolve() : reject(error)))
      );
      server = undefined;
      currentAddress = undefined;
    },
    address(): ProgressServerAddress {
      if (currentAddress === undefined) throw new Error("progress server is not listening");
      return currentAddress;
    }
  };
}
