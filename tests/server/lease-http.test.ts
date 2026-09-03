import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_CAPABILITIES } from "../../src/generated/capabilities.js";
import { createProgressServer } from "../../src/server/http-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(options: {
  scheduleTimer?: (callback: () => void, delayMs: number) => unknown;
  cancelTimer?: (handle: unknown) => void;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-lease-http-"));
  const tokenPath = join(directory, "auth.token");
  const requestShutdown = vi.fn();
  const server = createProgressServer({ port: 0, tokenPath, leaseGraceMs: 30_000, requestShutdown, ...options });
  await server.listen();
  cleanups.push(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { server, token: (await readFile(tokenPath, "utf8")).trim(), requestShutdown };
}

function headers(token: string, leaseId?: string, ownerNonce?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-codex-progress-hud-protocol": String(RELEASE_CAPABILITIES.protocol.current),
    ...(leaseId === undefined || ownerNonce === undefined ? {} : {
      "x-codex-progress-hud-client": "mcp",
      "x-codex-progress-hud-lease": leaseId,
      "x-codex-progress-hud-owner": ownerNonce
    })
  };
}

describe("MCP lease HTTP boundary", () => {
  it("supports owner-checked acquire, renew, bind, and release", async () => {
    const { server, token } = await fixture();
    const acquiredResponse = await fetch(`${server.address().url}/api/leases/acquire`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ ownerNonce: "owner-a", ttlMs: 30_000 })
    });
    expect(acquiredResponse.status).toBe(200);
    const lease = await acquiredResponse.json() as { id: string; ownerNonce: string; expiresAt: number };
    expect(lease.ownerNonce).toBe("owner-a");

    const bindResponse = await fetch(`${server.address().url}/api/leases/bind`, {
      method: "POST",
      headers: headers(token, lease.id, lease.ownerNonce),
      body: JSON.stringify({ id: lease.id, ownerNonce: lease.ownerNonce, taskHandle: "hud_aaaaaaaaaaaaaaaaaaaa" })
    });
    expect(bindResponse.status).toBe(200);

    const renewResponse = await fetch(`${server.address().url}/api/leases/renew`, {
      method: "POST",
      headers: headers(token, lease.id, lease.ownerNonce),
      body: JSON.stringify({ id: lease.id, ownerNonce: lease.ownerNonce, ttlMs: 40_000 })
    });
    expect(renewResponse.status).toBe(200);
    expect((await renewResponse.json()).expiresAt).toBeGreaterThan(lease.expiresAt);

    const releaseResponse = await fetch(`${server.address().url}/api/leases/release`, {
      method: "POST",
      headers: headers(token, lease.id, lease.ownerNonce),
      body: JSON.stringify({ id: lease.id, ownerNonce: lease.ownerNonce })
    });
    expect(releaseResponse.status).toBe(200);
  });

  it("rejects a second MCP session's cross-handle write without mutation", async () => {
    const { server, token } = await fixture();
    const acquire = async (ownerNonce: string) => {
      const response = await fetch(`${server.address().url}/api/leases/acquire`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ ownerNonce })
      });
      return await response.json() as { id: string; ownerNonce: string };
    };
    const first = await acquire("owner-a");
    const second = await acquire("owner-b");
    const firstWrite = await fetch(`${server.address().url}/api/events`, {
      method: "POST",
      headers: headers(token, first.id, first.ownerNonce),
      body: JSON.stringify({ taskId: "hud_aaaaaaaaaaaaaaaaaaaa", event: { type: "turn_started" } })
    });
    expect(firstWrite.status).toBe(202);
    const before = await (await fetch(`${server.address().url}/api/snapshot`, { headers: headers(token) })).json();

    const rejected = await fetch(`${server.address().url}/api/events`, {
      method: "POST",
      headers: headers(token, second.id, second.ownerNonce),
      body: JSON.stringify({ taskId: "hud_aaaaaaaaaaaaaaaaaaaa", event: { type: "activity_resumed" } })
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "LEASE_FORBIDDEN" });
    const after = await (await fetch(`${server.address().url}/api/snapshot`, { headers: headers(token) })).json();
    expect(after).toEqual(before);

    const hidden = await (await fetch(`${server.address().url}/api/snapshot`, {
      headers: headers(token, second.id, second.ownerNonce)
    })).json();
    expect(hidden.tasks).toEqual([]);
    expect(hidden.selected).toBeNull();
  });

  it("marks bound nonterminal tasks disconnected before graceful final-lease shutdown", async () => {
    let grace!: () => void;
    let delay = 0;
    const fixtureValue = await fixture({ scheduleTimer: (callback, delayMs) => {
      grace = callback;
      delay = delayMs;
      return "grace";
    } });
    const { server, token, requestShutdown } = fixtureValue;
    const acquired = await (await fetch(`${server.address().url}/api/leases/acquire`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ ownerNonce: "owner-a" })
    })).json() as { id: string; ownerNonce: string };
    await fetch(`${server.address().url}/api/events`, {
      method: "POST",
      headers: headers(token, acquired.id, acquired.ownerNonce),
      body: JSON.stringify({ taskId: "hud_aaaaaaaaaaaaaaaaaaaa", event: { type: "turn_started" } })
    });
    const released = await fetch(`${server.address().url}/api/leases/release`, {
      method: "POST",
      headers: headers(token, acquired.id, acquired.ownerNonce),
      body: JSON.stringify({ id: acquired.id, ownerNonce: acquired.ownerNonce })
    });
    expect(released.status).toBe(200);
    expect(delay).toBe(30_000);
    grace!();
    await new Promise((resolve) => setImmediate(resolve));
    const snapshot = await (await fetch(`${server.address().url}/api/snapshot`, { headers: headers(token) })).json();
    expect(snapshot.selected.task.status).toBe("disconnected_suspected");
    expect(requestShutdown).toHaveBeenCalledOnce();
  });

  it("cancels a pending final-lease shutdown when a new lease arrives", async () => {
    let grace!: () => void;
    let cancelled = false;
    const fixtureValue = await fixture({
      scheduleTimer: (callback) => {
      grace = callback;
      return "grace";
      },
      cancelTimer: () => { cancelled = true; }
    });
    const { server, token, requestShutdown } = fixtureValue;
    const first = await (await fetch(`${server.address().url}/api/leases/acquire`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ ownerNonce: "owner-a" })
    })).json() as { id: string; ownerNonce: string };
    await fetch(`${server.address().url}/api/events`, {
      method: "POST",
      headers: headers(token, first.id, first.ownerNonce),
      body: JSON.stringify({ taskId: "hud_aaaaaaaaaaaaaaaaaaaa", event: { type: "turn_started" } })
    });
    await fetch(`${server.address().url}/api/leases/release`, {
      method: "POST",
      headers: headers(token, first.id, first.ownerNonce),
      body: JSON.stringify({ id: first.id, ownerNonce: first.ownerNonce })
    });
    const second = await (await fetch(`${server.address().url}/api/leases/acquire`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ ownerNonce: "owner-b" })
    })).json() as { id: string; ownerNonce: string };
    expect(second.id).not.toBe(first.id);
    expect(cancelled).toBe(true);
    grace!();
    await new Promise((resolve) => setImmediate(resolve));
    const snapshot = await (await fetch(`${server.address().url}/api/snapshot`, { headers: headers(token) })).json();
    expect(snapshot.selected.task.status).toBe("running");
    expect(requestShutdown).not.toHaveBeenCalled();
  });
});
