import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HudHealth } from "../../src/lifecycle/types.js";
import { createProgressServer } from "../../src/server/http-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startServer(options: { withUi?: boolean; withGenerationGuard?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-"));
  const tokenPath = join(directory, "auth.token");
  const uiDirectory = options.withUi ? join(directory, "ui") : undefined;
  if (uiDirectory !== undefined) {
    await mkdir(uiDirectory);
    await mkdir(join(uiDirectory, "api"));
    await writeFile(join(uiDirectory, "index.html"), "<h1>HUD</h1>");
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
    expect(await response.json()).toEqual(health);
  });

  it("accepts authenticated idempotent window controls", async () => {
    const { baseUrl, token, showWindow, hideWindow } = await startServer();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
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
      headers: { authorization: `Bearer ${token}` },
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
        "content-type": "application/json"
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
        "content-type": "application/json; charset=utf-8"
      },
      body: "{}"
    });
    const spoofedResponse = await fetch(`${baseUrl}/api/window/hide`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/jsonx"
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
        "content-type": "application/json"
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
        "content-type": "application/json"
      },
      body: "{}"
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(requestShutdown).toHaveBeenCalledOnce();
  });

  it("rejects stale ensured writes and rejects every write after shutdown begins", async () => {
    const fixture = await startServer({ withGenerationGuard: true });
    const headers = {
      authorization: `Bearer ${fixture.token}`,
      "content-type": "application/json"
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
    expect(afterShutdown.status).toBe(409);
    expect(fixture.requestShutdown).toHaveBeenCalledOnce();
  });

  it("binds to loopback and exposes an authenticated empty snapshot", async () => {
    const { server, baseUrl, token } = await startServer();
    const response = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${token}` }
    });

    expect(server.address().host).toBe("127.0.0.1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task: null, eta: null });
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
        "content-type": "application/json"
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
      task: { id: string; status: string };
    };

    expect(response.status).toBe(202);
    expect(snapshot.task).toMatchObject({ id: "task-1", status: "running" });
  });

  it("rejects malformed JSON without changing state", async () => {
    const { baseUrl, token } = await startServer();
    const response = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: "{not-json"
    });

    expect(response.status).toBe(400);
    const snapshotResponse = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(await snapshotResponse.json()).toEqual({
      task: null,
      eta: null
    });
  });

  it("rejects request bodies larger than 64 KiB", async () => {
    const { baseUrl, token } = await startServer();
    const response = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
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
      'data: {"task":null,"eta":null}'
    );
  });

  it("serves the overlay shell with a restrictive content security policy", async () => {
    const { baseUrl } = await startServer({ withUi: true });
    const response = await fetch(baseUrl);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>HUD</h1>");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
