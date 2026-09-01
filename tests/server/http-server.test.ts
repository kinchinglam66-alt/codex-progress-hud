import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgressServer } from "../../src/server/http-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startServer() {
  const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-"));
  const tokenPath = join(directory, "auth.token");
  const server = createProgressServer({ port: 0, tokenPath });
  await server.listen();
  cleanups.push(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const token = (await readFile(tokenPath, "utf8")).trim();
  return { server, token, baseUrl: server.address().url };
}

describe("local progress HTTP service", () => {
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
});
