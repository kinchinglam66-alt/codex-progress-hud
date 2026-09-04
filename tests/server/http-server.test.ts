import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_CAPABILITIES } from "../../src/generated/capabilities.js";
import type { HudHealth } from "../../src/lifecycle/types.js";
import { createProgressServer } from "../../src/server/http-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startServer(options: { withUi?: boolean; withGenerationGuard?: boolean; bootstrapGeneration?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-"));
  const tokenPath = join(directory, "auth.token");
  const uiDirectory = options.withUi ? join(directory, "ui") : undefined;
  if (uiDirectory !== undefined) {
    await mkdir(uiDirectory);
    await mkdir(join(uiDirectory, "api"));
    await writeFile(join(uiDirectory, "index.html"), "<h1>HUD</h1>");
    await writeFile(join(uiDirectory, "styles.css"), "body { color: white; }");
    await writeFile(join(uiDirectory, "renderer.js"), [
      'import { buildHudView } from "./view-model.js";',
      'import { createTaskMutationController } from "./task-mutations.js";',
      'import { taskButtonAccessibility } from "./task-controls.js";',
      "void buildHudView; void createTaskMutationController; void taskButtonAccessibility;"
    ].join("\n"));
    await writeFile(join(uiDirectory, "view-model.js"), "export const buildHudView = () => ({});");
    await writeFile(join(uiDirectory, "task-mutations.js"), "export const createTaskMutationController = () => ({});");
    await writeFile(join(uiDirectory, "task-controls.js"), "export const taskButtonAccessibility = () => ({});");
    await writeFile(join(uiDirectory, "health"), "shadowed health");
    await writeFile(join(uiDirectory, "api", "health"), "shadowed API health");
  }
  const health: HudHealth = {
    service: "codex-progress-hud",
    pid: 12_345,
    version: "0.1.0",
    protocolVersion: 1,
    instanceNonce: "test-instance",
    startedAt: "2026-09-01T00:00:00.000Z",
    visibility: "visible"
  };
  const showWindow = vi.fn();
  const hideWindow = vi.fn();
  const requestShutdown = vi.fn();
  let generation = 1;
  let desiredState: "on" | "off" = "on";
  const runIfGeneration = vi.fn(async (
    requestedGeneration: number,
    requestedState: "on" | "off",
    operation: (signal: AbortSignal) => unknown | Promise<unknown>
  ) => requestedGeneration === generation && requestedState === desiredState
    ? { accepted: true as const, value: await operation(new AbortController().signal) }
    : { accepted: false as const });
  const server = createProgressServer({
    port: 0,
    tokenPath,
    health: () => health,
    showWindow,
    hideWindow,
    requestShutdown,
    bootstrap: () => ({
      protocolVersion: RELEASE_CAPABILITIES.protocol.current,
      generation: options.bootstrapGeneration ?? 1
    }),
    ...(options.withGenerationGuard ? { runIfGeneration } : {}),
    ...(uiDirectory === undefined ? {} : { uiDirectory })
  });
  await server.listen();
  cleanups.push(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const token = (await readFile(tokenPath, "utf8")).trim();
  return {
    server,
    token,
    baseUrl: server.address().url,
    health,
    showWindow,
    hideWindow,
    requestShutdown
    ,setLifecycle(nextGeneration: number, nextState: "on" | "off") {
      generation = nextGeneration;
      desiredState = nextState;
    }
  };
}

describe("local progress HTTP service", () => {
  const taskA = "hud_abcdefghijklmnopqrstuvwxyz0123456789";
  const taskB = "hud_BCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  function hookEnvelope(
    taskHandle: string,
    eventId: string,
    hook: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "Interrupt" | "SessionEnd",
    receivedAt = 100
  ) {
    return {
      schemaVersion: 1 as const,
      taskHandle,
      eventId,
      sessionKey: "session_abcdefghijklmnopqrstuvwxyz0123456789",
      turnKey: "turn_abcdefghijklmnopqrstuvwxyz0123456789",
      hook,
      source: "startup" as const,
      receivedAt
    };
  }

  function mutationHeaders(token: string, revision: number, generation = 1) {
    return {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current),
      "x-codex-progress-hud-generation": String(generation),
      "x-codex-progress-hud-revision": String(revision)
    };
  }
  it("exposes only minimal unauthenticated identity", async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "codex-progress-hud",
      protocolVersion: 1
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("exposes protocol and generation through an authenticated renderer bootstrap", async () => {
    const fixture = await startServer({ bootstrapGeneration: 9 });

    const unauthorized = await fetch(`${fixture.baseUrl}/api/bootstrap`);
    const authorized = await fetch(`${fixture.baseUrl}/api/bootstrap`, {
      headers: { authorization: `Bearer ${fixture.token}` }
    });

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ protocolVersion: 1, generation: 9 });
  });

  it("does not let UI files shadow reserved health routes", async () => {
    const { baseUrl } = await startServer({ withUi: true });

    const identityResponse = await fetch(`${baseUrl}/health`);
    const apiResponse = await fetch(`${baseUrl}/api/health`);

    expect(identityResponse.status).toBe(200);
    expect(await identityResponse.json()).toEqual({
      service: "codex-progress-hud",
      protocolVersion: 1
    });
    expect(apiResponse.status).toBe(401);
  });

  it("serves the complete renderer module graph from an exact static allowlist", async () => {
    const { baseUrl } = await startServer({ withUi: true });
    const pending = ["/renderer.js"];
    const loaded = new Map<string, string>();

    while (pending.length > 0) {
      const pathname = pending.shift()!;
      if (loaded.has(pathname)) continue;
      const response = await fetch(`${baseUrl}${pathname}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      const source = await response.text();
      loaded.set(pathname, source);
      for (const match of source.matchAll(/from\s+["']\.\/([^"']+)["']/gu)) {
        pending.push(`/${match[1]}`);
      }
    }

    expect([...loaded.keys()].sort()).toEqual([
      "/renderer.js",
      "/task-controls.js",
      "/task-mutations.js",
      "/view-model.js"
    ]);
    const css = await fetch(`${baseUrl}/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const denied = await Promise.all([
      "/task-controls.js.map",
      "/renderer.d.ts",
      "/task-controls.js/../package.json",
      "/%2e%2e/package.json"
    ].map((pathname) => fetch(`${baseUrl}${pathname}`)));
    expect(denied.map((response) => response.status)).toEqual([404, 404, 404, 404]);
  });

  it("rejects unauthenticated access to every new API route", async () => {
    const { baseUrl } = await startServer();

    const responses = await Promise.all([
      fetch(`${baseUrl}/api/health`),
      fetch(`${baseUrl}/api/window/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }),
      fetch(`${baseUrl}/api/window/hide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }),
      fetch(`${baseUrl}/api/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    ]);

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401, 401]);
  });

  it("returns full health only to an authenticated client", async () => {
    const { baseUrl, token, health } = await startServer();
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...health,
      capabilities: {
        service: "codex-progress-hud",
        companionVersion: health.version,
        protocol: RELEASE_CAPABILITIES.protocol,
        incompatibleClientSeen: false
      }
    });
  });

  it("rejects missing and unsupported client protocols distinctly from stale generations", async () => {
    const fixture = await startServer({ withGenerationGuard: true });
    const headers = {
      authorization: `Bearer ${fixture.token}`,
      "content-type": "application/json"
    };
    const event = JSON.stringify({
      taskId: "protocol-negotiation",
      title: "Protocol negotiation",
      event: { type: "turn_started" }
    });
    const sseController = new AbortController();
    const sseResponse = await fetch(`${fixture.baseUrl}/api/events`, {
      headers: { authorization: `Bearer ${fixture.token}` },
      signal: sseController.signal
    });
    const sseReader = sseResponse.body!.getReader();
    await sseReader.read();

    const missing = await fetch(`${fixture.baseUrl}/api/events`, {
      method: "POST",
      headers,
      body: event
    });
    const unsupported = await fetch(`${fixture.baseUrl}/api/events`, {
      method: "POST",
      headers: {
        ...headers,
        "x-codex-progress-hud-protocol": "999",
        "x-codex-progress-hud-generation": "1"
      },
      body: event
    });
    const stale = await fetch(`${fixture.baseUrl}/api/events`, {
      method: "POST",
      headers: {
        ...headers,
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current),
        "x-codex-progress-hud-generation": "0"
      },
      body: event
    });

    expect(missing.status).toBe(426);
    expect(await missing.json()).toEqual({
      error: "client protocol is unsupported",
      code: "VERSION_MISMATCH"
    });
    expect(unsupported.status).toBe(426);
    expect(await unsupported.json()).toEqual({
      error: "client protocol is unsupported",
      code: "VERSION_MISMATCH"
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "lifecycle generation rejected",
      code: "GENERATION_REJECTED"
    });
    const changed = await sseReader.read();
    sseController.abort();
    expect(new TextDecoder().decode(changed.value)).toContain(
      '"compatibility":{"incompatibleClientSeen":true}'
    );

    const snapshot = await fetch(`${fixture.baseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    expect((await snapshot.json()).compatibility).toEqual({ incompatibleClientSeen: true });

    const health = await fetch(`${fixture.baseUrl}/api/health`, {
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    expect((await health.json()).capabilities).toMatchObject({ incompatibleClientSeen: true });
  });

  it("records protocol incompatibility only in diagnostics, not task data", async () => {
    const fixture = await startServer();
    const response = await fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(hookEnvelope(taskA, "evt_abcdefghijklmnopqrstuvwxyz0123456789", "SessionStart"))
    });

    expect(response.status).toBe(426);
    expect(fixture.server.store.snapshot()).toMatchObject({
      revision: 1,
      tasks: [],
      selectedTaskId: null,
      compatibility: { incompatibleClientSeen: true }
    });
  });

  it("accepts authenticated idempotent window controls", async () => {
    const { baseUrl, token, showWindow, hideWindow } = await startServer();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
    };

    const showResponses = await Promise.all([
      fetch(`${baseUrl}/api/window/show`, { method: "POST", headers, body: "{}" }),
      fetch(`${baseUrl}/api/window/show`, { method: "POST", headers, body: "{}" })
    ]);
    const hideResponses = await Promise.all([
      fetch(`${baseUrl}/api/window/hide`, { method: "POST", headers, body: "{}" }),
      fetch(`${baseUrl}/api/window/hide`, { method: "POST", headers, body: "{}" })
    ]);

    expect(showResponses.map(({ status }) => status)).toEqual([202, 202]);
    expect(hideResponses.map(({ status }) => status)).toEqual([202, 202]);
    expect(await showResponses[0].json()).toEqual({ accepted: true });
    expect(await hideResponses[0].json()).toEqual({ accepted: true });
    expect(showWindow).toHaveBeenCalledTimes(2);
    expect(hideWindow).toHaveBeenCalledTimes(2);
  });

  it("requires JSON for authenticated controls", async () => {
    const { baseUrl, token, hideWindow } = await startServer();
    const response = await fetch(`${baseUrl}/api/window/hide`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
      },
      body: "{}"
    });

    expect(response.status).toBe(415);
    expect(hideWindow).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["null", "null"],
    ["array", "[]"],
    ["primitive", "7"],
    ["non-empty object", '{"unexpected":true}']
  ])("rejects a %s control payload without invoking its callback", async (_name, body) => {
    const { baseUrl, token, showWindow } = await startServer();

    const response = await fetch(`${baseUrl}/api/window/show`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
      },
      body
    });

    expect(response.status).toBe(400);
    expect(showWindow).not.toHaveBeenCalled();
  });

  it("accepts JSON parameters but rejects a prefix-spoofed control media type", async () => {
    const { baseUrl, token, hideWindow } = await startServer();

    const acceptedResponse = await fetch(`${baseUrl}/api/window/hide`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
      },
      body: "{}"
    });
    const spoofedResponse = await fetch(`${baseUrl}/api/window/hide`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/jsonx",
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
      },
      body: "{}"
    });

    expect(acceptedResponse.status).toBe(202);
    expect(spoofedResponse.status).toBe(415);
    expect(hideWindow).toHaveBeenCalledOnce();
  });

  it("applies the 64 KiB body limit to authenticated controls", async () => {
    const { baseUrl, token, showWindow } = await startServer();
    const response = await fetch(`${baseUrl}/api/window/show`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
      },
      body: JSON.stringify({ padding: "x".repeat(70_000) })
    });

    expect(response.status).toBe(413);
    expect(showWindow).not.toHaveBeenCalled();
  });

  it("acknowledges authenticated shutdown after callback acceptance", async () => {
    const { baseUrl, token, requestShutdown } = await startServer();
    const response = await fetch(`${baseUrl}/api/shutdown`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
      },
      body: "{}"
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(requestShutdown).toHaveBeenCalledOnce();
  });

  it("reserves 409 for generation rejection and reports shutdown-in-progress as 423", async () => {
    const fixture = await startServer({ withGenerationGuard: true });
    const headers = {
      authorization: `Bearer ${fixture.token}`,
      "content-type": "application/json",
      "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
    };
    const event = JSON.stringify({
      taskId: "generation-race",
      title: "Generation race",
      event: { type: "turn_started" }
    });

    const missing = await fetch(`${fixture.baseUrl}/api/events`, {
      method: "POST",
      headers,
      body: event
    });
    const stale = await fetch(`${fixture.baseUrl}/api/events`, {
      method: "POST",
      headers: { ...headers, "x-codex-progress-hud-generation": "0" },
      body: event
    });
    const current = await fetch(`${fixture.baseUrl}/api/events`, {
      method: "POST",
      headers: { ...headers, "x-codex-progress-hud-generation": "1" },
      body: event
    });

    expect([missing.status, stale.status, current.status]).toEqual([409, 409, 202]);

    fixture.setLifecycle(2, "off");
    const shutdown = await fetch(`${fixture.baseUrl}/api/shutdown`, {
      method: "POST",
      headers: { ...headers, "x-codex-progress-hud-generation": "2" },
      body: "{}"
    });
    fixture.setLifecycle(3, "on");
    const afterShutdown = await fetch(`${fixture.baseUrl}/api/events`, {
      method: "POST",
      headers: { ...headers, "x-codex-progress-hud-generation": "3" },
      body: event
    });

    expect(shutdown.status).toBe(202);
    expect(afterShutdown.status).toBe(423);
    expect(await afterShutdown.json()).toEqual({
      error: "shutdown in progress",
      code: "SHUTTING_DOWN"
    });
    expect(fixture.requestShutdown).toHaveBeenCalledOnce();
  });

  it("binds to loopback and exposes an authenticated empty snapshot", async () => {
    const { server, baseUrl, token } = await startServer();
    const response = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${token}` }
    });

    expect(server.address().host).toBe("127.0.0.1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revision: 0,
      selectedTaskId: null,
      selectionMode: "follow_activity",
      tasks: [],
      selected: null,
      compatibility: { incompatibleClientSeen: false },
      hooks: { activitySeen: false },
      capabilities: {
        service: "codex-progress-hud",
        companionVersion: "0.1.0",
        protocol: RELEASE_CAPABILITIES.protocol,
        incompatibleClientSeen: false
      }
    });
  });

  it("rejects unauthenticated mutation", async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "task-1",
        title: "Fix login",
        event: { type: "turn_started" }
      })
    });

    expect(response.status).toBe(401);
  });

  it("rejects unauthenticated snapshot reads", async () => {
    const { baseUrl } = await startServer();

    expect((await fetch(`${baseUrl}/api/snapshot`)).status).toBe(401);
  });

  it("reduces an authenticated event into the current snapshot", async () => {
    const { baseUrl, token } = await startServer();
    const response = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
      },
      body: JSON.stringify({
        taskId: "task-1",
        title: "Fix login",
        event: { type: "turn_started" }
      })
    });
    const snapshotResponse = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const snapshot = (await snapshotResponse.json()) as {
      selected: { task: { id: string; status: string } } | null;
    };

    expect(response.status).toBe(202);
    expect(snapshot.selected?.task).toMatchObject({ id: "task-1", status: "running" });
  });

  it("rejects unknown per-task controls without creating, revising, or selecting a task", async () => {
    const { baseUrl, token } = await startServer({ withGenerationGuard: true });
    const started = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: mutationHeaders(token, 0),
      body: JSON.stringify({
        taskId: taskA,
        title: "Established task",
        event: { type: "tracking_started" }
      })
    });
    expect(started.status).toBe(202);
    const before = await (await fetch(`${baseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();

    for (const type of ["tracking_paused", "tracking_resumed", "tracking_stopped"] as const) {
      const response = await fetch(`${baseUrl}/api/events`, {
        method: "POST",
        headers: mutationHeaders(token, 1),
        body: JSON.stringify({ taskId: taskB, event: { type } })
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "task handle is not associated with a tracked task",
        code: "TASK_NOT_FOUND"
      });
      const after = await (await fetch(`${baseUrl}/api/snapshot`, {
        headers: { authorization: `Bearer ${token}` }
      })).json();
      expect(after).toEqual(before);
    }
  });

  it("preserves established titles unless a semantic report supplies a bounded replacement", async () => {
    const { baseUrl, token } = await startServer({ withGenerationGuard: true });
    const post = (revision: number, body: unknown) => fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: mutationHeaders(token, revision),
      body: JSON.stringify(body)
    });

    expect((await post(0, {
      taskId: taskA,
      title: "Established title",
      event: { type: "tracking_started" }
    })).status).toBe(202);
    expect((await post(1, {
      taskId: taskA,
      event: { type: "tracking_paused" }
    })).status).toBe(202);
    expect((await post(2, {
      taskId: taskA,
      event: { type: "model_progress", phase: "testing" }
    })).status).toBe(202);

    let snapshot = await (await fetch(`${baseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${token}` }
    })).json() as { revision: number; selected: { task: { title: string } } };
    expect(snapshot.selected.task.title).toBe("Established title");

    expect((await post(snapshot.revision, {
      taskId: taskA,
      title: "Supplied replacement",
      event: { type: "model_progress", phase: "verification" }
    })).status).toBe(202);
    snapshot = await (await fetch(`${baseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${token}` }
    })).json() as { revision: number; selected: { task: { title: string } } };
    expect(snapshot.selected.task.title).toBe("Supplied replacement");
  });

  it.each(["not-a-deadline", "0001", "9007199254740992", "9007199254740991"])(
    "treats malformed request deadline %s as absent for compatibility",
    async (deadline) => {
      const emitWarning = vi.spyOn(process, "emitWarning");
      cleanups.push(async () => emitWarning.mockRestore());
      const { baseUrl, token } = await startServer();
      const response = await fetch(`${baseUrl}/api/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current),
          "x-codex-progress-hud-deadline-ms": deadline
        },
        body: JSON.stringify({
          taskId: "legacy-deadline-client",
          title: "Compatibility",
          event: { type: "turn_started" }
        })
      });

      expect(response.status).toBe(202);
      expect(emitWarning).not.toHaveBeenCalled();
    }
  );

  it("rejects malformed JSON without changing state", async () => {
    const { baseUrl, token } = await startServer();
    const response = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
      },
      body: "{not-json"
    });

    expect(response.status).toBe(400);
    const snapshotResponse = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(await snapshotResponse.json()).toMatchObject({
      selected: null,
      capabilities: { incompatibleClientSeen: false }
    });
  });

  it("rejects request bodies larger than 64 KiB", async () => {
    const { baseUrl, token } = await startServer();
    const response = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current)
      },
      body: JSON.stringify({ padding: "x".repeat(70_000) })
    });

    expect(response.status).toBe(413);
  });

  it("streams the current snapshot to an authenticated SSE client", async () => {
    const { baseUrl, token } = await startServer();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    const firstChunk = await reader?.read();
    controller.abort();

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(firstChunk?.value)).toContain(
      'data: {"revision":0,"selectedTaskId":null,"selectionMode":"follow_activity","tasks":[],"selected":null,"compatibility":{"incompatibleClientSeen":false},"hooks":{"activitySeen":false},"capabilities":'
    );
  });

  it("serves the overlay shell with a restrictive content security policy", async () => {
    const { baseUrl } = await startServer({ withUi: true });
    const response = await fetch(baseUrl);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>HUD</h1>");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("ingests authenticated Hooks, deduplicates event IDs, and rejects stale revisions", async () => {
    const fixture = await startServer({ withGenerationGuard: true });
    const postHook = (envelope: unknown, revision: number) => fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: mutationHeaders(fixture.token, revision),
      body: JSON.stringify(envelope)
    });

    const first = await postHook(hookEnvelope(taskA, "evt_abcdefghijklmnopqrstuvwxyz0123456789", "SessionStart"), 0);
    const duplicate = await postHook(hookEnvelope(taskA, "evt_abcdefghijklmnopqrstuvwxyz0123456789", "SessionStart"), 1);
    const stale = await postHook(hookEnvelope(taskB, "evt_BCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "SessionStart"), 0);

    expect(first.status).toBe(202);
    expect((await first.json()).revision).toBe(1);
    expect(duplicate.status).toBe(202);
    expect((await duplicate.json()).revision).toBe(1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "task revision is stale",
      code: "STALE_REVISION",
      revision: 1
    });
    expect(fixture.server.hookActivity()).toEqual({ activitySeen: true, lastEventAt: 100 });
    expect(fixture.server.store.snapshot().tasks).toHaveLength(1);
  });

  it("does not let duplicate Hook IDs bypass missing or stale revision guards", async () => {
    const fixture = await startServer();
    const envelope = hookEnvelope(taskA, "evt_abcdefghijklmnopqrstuvwxyz0123456789", "SessionStart");
    const post = (revision: number | undefined) => fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "content-type": "application/json",
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current),
        ...(revision === undefined ? {} : { "x-codex-progress-hud-revision": String(revision) })
      },
      body: JSON.stringify(envelope)
    });

    expect((await post(0)).status).toBe(202);
    expect((await post(undefined)).status).toBe(428);
    const stale = await post(0);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "STALE_REVISION", revision: 1 });
    expect(fixture.server.store.snapshot().revision).toBe(1);
  });

  it("applies concurrent deliveries of one Hook ID at most once", async () => {
    const fixture = await startServer();
    const envelope = hookEnvelope(taskA, "evt_abcdefghijklmnopqrstuvwxyz0123456789", "SessionStart");
    const post = () => fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "content-type": "application/json",
        "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current),
        "x-codex-progress-hud-revision": "0"
      },
      body: JSON.stringify(envelope)
    });

    const responses = await Promise.all([post(), post()]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(fixture.server.store.snapshot()).toMatchObject({ revision: 1, tasks: [{ id: taskA }] });
  });

  it("guards Hook ingestion with authentication, protocol, generation, and bounded bodies", async () => {
    const fixture = await startServer({ withGenerationGuard: true });
    const envelope = hookEnvelope(taskA, "evt_abcdefghijklmnopqrstuvwxyz0123456789", "SessionStart");
    const unauthenticated = await fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
    const noProtocol = await fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: { ...mutationHeaders(fixture.token, 0), "x-codex-progress-hud-protocol": "" },
      body: JSON.stringify(envelope)
    });
    const staleGeneration = await fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: { ...mutationHeaders(fixture.token, 0), "x-codex-progress-hud-generation": "0" },
      body: JSON.stringify(envelope)
    });
    const oversized = await fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: mutationHeaders(fixture.token, 0),
      body: JSON.stringify({ ...envelope, arbitrary: "x".repeat(70_000) })
    });

    expect(unauthenticated.status).toBe(401);
    expect(noProtocol.status).toBe(426);
    expect(staleGeneration.status).toBe(409);
    expect(oversized.status).toBe(413);
    expect(fixture.server.store.snapshot().revision).toBe(1);
  });

  it("selects and hides URL-safe tasks with revision checks", async () => {
    const fixture = await startServer({ withGenerationGuard: true });
    const postHook = (envelope: unknown, revision: number) => fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: mutationHeaders(fixture.token, revision),
      body: JSON.stringify(envelope)
    });
    await postHook(hookEnvelope(taskA, "evt_abcdefghijklmnopqrstuvwxyz0123456789", "SessionStart", 100), 0);
    await postHook(hookEnvelope(taskB, "evt_BCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "SessionStart", 200), 1);

    const selected = await fetch(`${fixture.baseUrl}/api/tasks/${encodeURIComponent(taskA)}/select`, {
      method: "POST",
      headers: mutationHeaders(fixture.token, 2),
      body: JSON.stringify({ mode: "pinned" })
    });
    const hidden = await fetch(`${fixture.baseUrl}/api/tasks/${encodeURIComponent(taskA)}/visibility`, {
      method: "POST",
      headers: mutationHeaders(fixture.token, 3),
      body: JSON.stringify({ hidden: true })
    });
    const stale = await fetch(`${fixture.baseUrl}/api/tasks/${encodeURIComponent(taskB)}/select`, {
      method: "POST",
      headers: mutationHeaders(fixture.token, 3),
      body: JSON.stringify({ mode: "pinned" })
    });
    const traversal = await fetch(`${fixture.baseUrl}/api/tasks/${encodeURIComponent(`${taskA}/../${taskB}`)}/select`, {
      method: "POST",
      headers: mutationHeaders(fixture.token, 4),
      body: JSON.stringify({ mode: "pinned" })
    });

    expect(selected.status).toBe(202);
    expect((await selected.json()).selectedTaskId).toBe(taskA);
    expect(hidden.status).toBe(202);
    expect((await hidden.json()).tasks.find((task: { id: string }) => task.id === taskA).hiddenForTask).toBe(true);
    expect(stale.status).toBe(409);
    expect((await stale.json()).revision).toBe(4);
    expect(traversal.status).toBe(404);
    expect(fixture.server.store.snapshot()).toMatchObject({ revision: 4, selectedTaskId: taskA });
  });

  it("rejects raw and encoded task dot-segments or separators before URL normalization", async () => {
    const fixture = await startServer();
    const seed = hookEnvelope(taskB, "evt_abcdefghijklmnopqrstuvwxyz0123456789", "SessionStart");
    await fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: mutationHeaders(fixture.token, 0),
      body: JSON.stringify(seed)
    });
    const requests = [
      `/api/tasks/${taskA}/../${taskB}/select`,
      `/api/tasks/${taskA}/%2e%2e/${taskB}/select`,
      `/api/tasks/${taskA}%2F..%2F${taskB}/select`
    ];

    const responses = await Promise.all(requests.map((path) => new Promise<number>((resolve, reject) => {
      const address = new URL(fixture.baseUrl);
      const request = httpRequest({
        hostname: address.hostname,
        port: Number(address.port),
        path,
        method: "POST",
        headers: mutationHeaders(fixture.token, 1)
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 500));
      });
      request.once("error", reject);
      request.end(JSON.stringify({ mode: "pinned" }));
    })));

    expect(responses).toEqual([404, 404, 404]);
    expect(fixture.server.store.snapshot()).toMatchObject({ revision: 1, selectedTaskId: taskB });
  });

  it("supports snapshot reconnects and complete aggregate SSE after a revision gap", async () => {
    const fixture = await startServer({ withGenerationGuard: true });
    const postHook = (envelope: unknown, revision: number) => fetch(`${fixture.baseUrl}/api/hooks/events`, {
      method: "POST",
      headers: mutationHeaders(fixture.token, revision),
      body: JSON.stringify(envelope)
    });
    await postHook(hookEnvelope(taskA, "evt_abcdefghijklmnopqrstuvwxyz0123456789", "SessionStart"), 0);

    const unchanged = await fetch(`${fixture.baseUrl}/api/snapshot?afterRevision=1`, {
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    const gap = await fetch(`${fixture.baseUrl}/api/snapshot?afterRevision=0`, {
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    expect(unchanged.status).toBe(204);
    expect(gap.status).toBe(200);
    expect(await gap.json()).toMatchObject({ revision: 1, tasks: [{ id: taskA }] });

    const controller = new AbortController();
    const stream = await fetch(`${fixture.baseUrl}/api/events?afterRevision=1`, {
      headers: { authorization: `Bearer ${fixture.token}` },
      signal: controller.signal
    });
    const reader = stream.body!.getReader();
    const pending = reader.read();
    await postHook(hookEnvelope(taskA, "evt_BCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "PostToolUse", 200), 1);
    const changed = await pending;
    controller.abort();

    expect(stream.status).toBe(200);
    const data = new TextDecoder().decode(changed.value);
    expect(data).toContain("data: ");
    expect(JSON.parse(data.split("data: ")[1]!.split("\n", 1)[0]!)).toMatchObject({
      revision: 2,
      selectedTaskId: taskA,
      tasks: [{ id: taskA, title: "Codex task", hiddenForTask: false }],
      selected: { task: { id: taskA, status: "running" } }
    });
  });
});
