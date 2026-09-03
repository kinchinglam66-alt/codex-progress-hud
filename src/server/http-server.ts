import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { parseProgressEnvelope, type ProgressEnvelope } from "../core/schema.js";
import { RELEASE_CAPABILITIES, acceptsClientProtocol } from "../generated/capabilities.js";
import { parseHookEnvelope, type HookEnvelope } from "../hooks/schema.js";
import { PROTOCOL_VERSION, type HudCapabilities, type HudHealth } from "../lifecycle/types.js";
import type { DesiredHudState } from "../lifecycle/types.js";
import { loadOrCreateToken, tokensEqual } from "./token-store.js";
import { TaskStore, type HudSnapshot } from "./task-store.js";

const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_DEADLINE_HEADER = "x-codex-progress-hud-deadline-ms";
const REQUEST_PROTOCOL_HEADER = "x-codex-progress-hud-protocol";
const REQUEST_REVISION_HEADER = "x-codex-progress-hud-revision";
const REQUEST_GENERATION_HEADER = "x-codex-progress-hud-generation";
const MAX_REQUEST_DEADLINE_AHEAD_MS = 60_000;
const MAX_REMEMBERED_HOOK_IDS = 4_096;

const selectionRequestSchema = z.object({
  mode: z.enum(["pinned", "follow_activity"])
}).strict();
const visibilityRequestSchema = z.object({ hidden: z.boolean() }).strict();

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
    operation: (signal: AbortSignal) => unknown | Promise<unknown>,
    signal: AbortSignal
  ): Promise<{ accepted: false } | { accepted: true; value: unknown }>;
}

export interface ProgressServerAddress {
  host: string;
  port: number;
  url: string;
}

class BodyTooLargeError extends Error {}
class RequestDeadlineExpiredError extends Error {}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function requestDeadline(request: IncomingMessage): number | undefined {
  const header = request.headers[REQUEST_DEADLINE_HEADER];
  if (typeof header !== "string" || !/^(?:0|[1-9]\d*)$/u.test(header)) return undefined;
  const deadline = Number(header);
  if (!Number.isSafeInteger(deadline)) return undefined;
  return deadline - Date.now() <= MAX_REQUEST_DEADLINE_AHEAD_MS ? deadline : undefined;
}

function requestCancellation(
  request: IncomingMessage,
  response: ServerResponse
): { signal: AbortSignal; complete(): void; dispose(): void } {
  const controller = new AbortController();
  const socket = request.socket;
  const deadline = requestDeadline(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  const cancel = (reason?: unknown) => {
    if (!completed && !controller.signal.aborted) controller.abort(reason);
  };
  const cancelDisconnected = () => cancel();
  const dispose = () => {
    request.removeListener("aborted", cancelDisconnected);
    response.removeListener("close", cancelDisconnected);
    socket.removeListener("close", cancelDisconnected);
    if (timer !== undefined) clearTimeout(timer);
  };
  request.once("aborted", cancelDisconnected);
  response.once("close", cancelDisconnected);
  socket.once("close", cancelDisconnected);
  if (deadline !== undefined) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      cancel(new RequestDeadlineExpiredError("HUD request deadline expired"));
    } else {
      timer = setTimeout(
        () => cancel(new RequestDeadlineExpiredError("HUD request deadline expired")),
        remainingMs
      );
      timer.unref();
    }
  }
  return {
    signal: controller.signal,
    complete() {
      completed = true;
      dispose();
    },
    dispose
  };
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

function requestNonnegativeInteger(request: IncomingMessage, headerName: string): number | undefined {
  const header = request.headers[headerName];
  if (typeof header !== "string" || !/^(?:0|[1-9]\d*)$/u.test(header)) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : undefined;
}

function requestRevision(request: IncomingMessage): number | undefined {
  return requestNonnegativeInteger(request, REQUEST_REVISION_HEADER);
}

function taskRoute(pathname: string): { taskId: string; action: "select" | "visibility" } | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/(select|visibility)$/u.exec(pathname);
  if (match === null) return undefined;
  let taskId: string;
  try {
    taskId = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId)) return undefined;
  return { taskId, action: match[2] as "select" | "visibility" };
}

function unsafeTaskRequestTarget(rawUrl: string): boolean {
  const rawPath = rawUrl.split("?", 1)[0] ?? rawUrl;
  if (!rawPath.startsWith("/api/tasks/")) return false;
  for (const segment of rawPath.split("/").slice(3)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      return true;
    }
  }
  return false;
}

function afterRevision(url: URL): number | undefined {
  const value = url.searchParams.get("afterRevision");
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new SyntaxError("invalid afterRevision");
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new SyntaxError("invalid afterRevision");
  return revision;
}

function hookProgressEnvelope(envelope: HookEnvelope): ProgressEnvelope {
  switch (envelope.hook) {
    case "SessionStart":
      return {
        taskId: envelope.taskHandle,
        title: "Codex task",
        event: {
          type: "session_attached" as const,
          origin: envelope.source === undefined || envelope.source === "startup"
            ? "session_start" as const
            : "late_attach" as const
        }
      };
    case "UserPromptSubmit":
      return {
        taskId: envelope.taskHandle,
        title: "Codex task",
        event: envelope.turnKey === undefined
          ? { type: "turn_started" as const }
          : { type: "turn_started" as const, turnId: envelope.turnKey }
      };
    case "PostToolUse":
      return {
        taskId: envelope.taskHandle,
        title: "Codex task",
        event: { type: "activity_seen" as const, category: "hook" as const }
      };
    case "Stop":
      return {
        taskId: envelope.taskHandle,
        title: "Codex task",
        event: { type: "turn_stopped" as const }
      };
    case "Interrupt":
      return {
        taskId: envelope.taskHandle,
        title: "Codex task",
        event: { type: "runtime_interrupted" as const }
      };
    case "SessionEnd":
      return {
        taskId: envelope.taskHandle,
        title: "Codex task",
        event: { type: "session_ended" as const }
      };
  }
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
  const hookEventIds = new Set<string>();
  const hookEventOrder: string[] = [];
  function capabilities(health: HudHealth): HudCapabilities {
    return {
      service: "codex-progress-hud",
      companionVersion: health.version,
      protocol: RELEASE_CAPABILITIES.protocol,
      incompatibleClientSeen: store.snapshot().compatibility.incompatibleClientSeen
    };
  }

  function snapshotPayload(snapshot = store.snapshot()): HudSnapshot & { capabilities?: HudCapabilities } {
    if (options.health === undefined) return snapshot;
    return { ...snapshot, capabilities: capabilities(options.health()) };
  }

  function requestGeneration(request: IncomingMessage): number | undefined {
    return requestNonnegativeInteger(request, REQUEST_GENERATION_HEADER);
  }

  function requestProtocol(request: IncomingMessage): number | undefined {
    const header = request.headers[REQUEST_PROTOCOL_HEADER];
    if (typeof header !== "string" || !/^\d+$/u.test(header)) return undefined;
    const protocol = Number(header);
    return Number.isSafeInteger(protocol) ? protocol : undefined;
  }

  async function runMutation(
    request: IncomingMessage,
    desiredState: DesiredHudState,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => unknown | Promise<unknown>
  ): Promise<
    | { accepted: false; reason: "version_mismatch" | "generation_rejected" | "shutting_down" }
    | { accepted: true; value: unknown }
  > {
    const clientProtocol = requestProtocol(request);
    if (clientProtocol === undefined || !acceptsClientProtocol(clientProtocol)) {
      store.setIncompatibleClientSeen(true);
      return { accepted: false, reason: "version_mismatch" };
    }
    if (shuttingDown) return { accepted: false, reason: "shutting_down" };
    if (options.runIfGeneration === undefined) {
      if (signal.aborted) throw signal.reason;
      return { accepted: true, value: await operation(signal) };
    }
    const generation = requestGeneration(request);
    if (generation === undefined) return { accepted: false, reason: "generation_rejected" };
    const result = await options.runIfGeneration(generation, desiredState, operation, signal);
    return result.accepted ? result : { accepted: false, reason: "generation_rejected" };
  }

  function writeMutationRejection(
    response: ServerResponse,
    result: { accepted: false; reason: "version_mismatch" | "generation_rejected" | "shutting_down" }
  ): void {
    if (result.reason === "version_mismatch") {
      writeJson(response, 426, {
        error: "client protocol is unsupported",
        code: "VERSION_MISMATCH"
      });
      return;
    }
    if (result.reason === "shutting_down") {
      writeJson(response, 423, { error: "shutdown in progress", code: "SHUTTING_DOWN" });
      return;
    }
    writeJson(response, 409, {
      error: "lifecycle generation rejected",
      code: "GENERATION_REJECTED"
    });
  }

  function rememberHookEvent(eventId: string): void {
    hookEventIds.add(eventId);
    hookEventOrder.push(eventId);
    while (hookEventOrder.length > MAX_REMEMBERED_HOOK_IDS) {
      const oldest = hookEventOrder.shift();
      if (oldest !== undefined) hookEventIds.delete(oldest);
    }
  }

  function writeStaleRevision(response: ServerResponse): void {
    const revision = store.snapshot().revision;
    writeJson(response, 409, {
      error: "task revision is stale",
      code: "STALE_REVISION",
      revision
    });
  }

  function writeRevisionRequired(response: ServerResponse): void {
    writeJson(response, 428, {
      error: "task revision is required",
      code: "REVISION_REQUIRED",
      revision: store.snapshot().revision
    });
  }

  async function handleSse(response: ServerResponse, requestedRevision: number | undefined): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff"
    });
    const send = (snapshot: HudSnapshot) => {
      return response.write(`data: ${JSON.stringify(snapshotPayload(snapshot))}\n\n`);
    };
    response.flushHeaders();
    store.on("changed", send);
    const current = store.snapshot();
    if (requestedRevision === undefined || requestedRevision !== current.revision) send(current);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    response.once("close", () => {
      clearInterval(heartbeat);
      store.off("changed", send);
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cancellation = requestCancellation(request, response);
    try {
      const unsafeTaskTarget = unsafeTaskRequestTarget(request.url ?? "/");
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          service: "codex-progress-hud",
          protocolVersion: RELEASE_CAPABILITIES.protocol.current
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
      if (unsafeTaskTarget) {
        writeJson(response, 404, { error: "not found" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        const requestedRevision = afterRevision(url);
        const snapshot = store.snapshot();
        if (requestedRevision === snapshot.revision) {
          response.writeHead(204, {
            "cache-control": "no-store",
            "x-codex-progress-hud-revision": String(snapshot.revision),
            "x-content-type-options": "nosniff"
          });
          response.end();
        } else {
          writeJson(response, 200, snapshotPayload(snapshot));
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        if (options.health === undefined) throw new Error("health callback is unavailable");
        const health = options.health();
        writeJson(response, 200, { ...health, capabilities: capabilities(health) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        await handleSse(response, afterRevision(url));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/hooks/events") {
        if (!hasJsonMediaType(request)) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        const envelope = parseHookEnvelope(await readJson(request));
        const result = await runMutation(request, "on", cancellation.signal, (signal) => {
          if (signal.aborted) throw signal.reason;
          const revision = requestRevision(request);
          if (revision === undefined) return { kind: "revision_required" as const };
          if (revision !== store.snapshot().revision) return { kind: "stale_revision" as const };
          if (hookEventIds.has(envelope.eventId)) return store.snapshot();
          const snapshot = store.apply(hookProgressEnvelope(envelope), envelope.receivedAt);
          rememberHookEvent(envelope.eventId);
          return snapshot;
        });
        cancellation.complete();
        if (!result.accepted) {
          writeMutationRejection(response, result);
          return;
        }
        if (result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "revision_required") {
          writeRevisionRequired(response);
          return;
        }
        if (result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "stale_revision") {
          writeStaleRevision(response);
          return;
        }
        writeJson(response, 202, result.value);
        return;
      }
      const route = request.method === "POST" ? taskRoute(url.pathname) : undefined;
      if (route !== undefined) {
        if (!hasJsonMediaType(request)) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        const selectionMode = route.action === "select"
          ? selectionRequestSchema.parse(await readJson(request)).mode
          : undefined;
        const visibilityHidden = route.action === "visibility"
          ? visibilityRequestSchema.parse(await readJson(request)).hidden
          : undefined;
        const result = await runMutation(request, "on", cancellation.signal, (signal) => {
          if (signal.aborted) throw signal.reason;
          const revision = requestRevision(request);
          if (revision === undefined) return { kind: "revision_required" as const };
          if (revision !== store.snapshot().revision) return { kind: "stale_revision" as const };
          if (!store.snapshot().tasks.some((task) => task.id === route.taskId)) {
            return { kind: "task_not_found" as const };
          }
          const snapshot = route.action === "select"
            ? store.select(route.taskId, selectionMode!, Date.now())
            : store.setHidden(route.taskId, visibilityHidden!, Date.now());
          return snapshot;
        });
        cancellation.complete();
        if (!result.accepted) {
          writeMutationRejection(response, result);
          return;
        }
        if (result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value) {
          if (result.value.kind === "revision_required") {
            writeRevisionRequired(response);
            return;
          }
          if (result.value.kind === "stale_revision") {
            writeStaleRevision(response);
            return;
          }
          if (result.value.kind === "task_not_found") {
            writeJson(response, 404, { error: "task not found" });
            return;
          }
        }
        writeJson(response, 202, result.value);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/events") {
        if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        const envelope = parseProgressEnvelope(await readJson(request));
        const result = await runMutation(request, "on", cancellation.signal, (signal) => {
          if (signal.aborted) throw signal.reason;
          if (
            (envelope.event.type === "tracking_paused" ||
              envelope.event.type === "tracking_resumed" ||
              envelope.event.type === "tracking_stopped") &&
            !store.has(envelope.taskId)
          ) {
            return { kind: "task_not_found" as const };
          }
          return store.apply(envelope);
        });
        cancellation.complete();
        if (!result.accepted) {
          writeMutationRejection(response, result);
          return;
        }
        if (
          result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "task_not_found"
        ) {
          writeJson(response, 404, {
            error: "task handle is not associated with a tracked task",
            code: "TASK_NOT_FOUND"
          });
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
        const result = await runMutation(request, desiredState, cancellation.signal, async (signal) => {
          if (signal.aborted) throw signal.reason;
          if (url.pathname === "/api/shutdown") {
            if (signal.aborted) throw signal.reason;
            shuttingDown = true;
          }
          if (signal.aborted) throw signal.reason;
          await callback();
        });
        cancellation.complete();
        if (!result.accepted) {
          writeMutationRejection(response, result);
          return;
        }
        writeJson(response, 202, { accepted: true });
        return;
      }
      writeJson(response, 404, { error: "not found" });
    } catch (error) {
      if (cancellation.signal.reason instanceof RequestDeadlineExpiredError) {
        writeJson(response, 408, { error: "request deadline expired" });
      } else if (error instanceof BodyTooLargeError) {
        writeJson(response, 413, { error: error.message });
      } else if (error instanceof SyntaxError || error instanceof ZodError) {
        writeJson(response, 400, { error: "invalid request payload" });
      } else {
        writeJson(response, 500, { error: "internal server error" });
      }
    } finally {
      cancellation.dispose();
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
