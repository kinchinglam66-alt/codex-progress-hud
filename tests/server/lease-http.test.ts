import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_CAPABILITIES } from "../../src/generated/capabilities.js";
import { createProgressServer } from "../../src/server/http-server.js";
import { LeaseStore } from "../../src/server/lease-store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(options: {
  scheduleTimer?: (callback: () => void, delayMs: number) => unknown;
  cancelTimer?: (handle: unknown) => void;
  leaseStore?: LeaseStore;
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

    const taskHandle = "hud_aaaaaaaaaaaaaaaaaaaa";
    await fetch(`${server.address().url}/api/events`, {
      method: "POST",
      headers: headers(token, lease.id, lease.ownerNonce),
      body: JSON.stringify({ taskId: taskHandle, event: { type: "turn_started" } })
    });
    const bindResponse = await fetch(`${server.address().url}/api/leases/bind`, {
      method: "POST",
      headers: headers(token, lease.id, lease.ownerNonce),
      body: JSON.stringify({ id: lease.id, ownerNonce: lease.ownerNonce, taskHandle })
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

  it("lease-scopes every MCP aggregate mutation response", async () => {
    const { server, token } = await fixture();
    const acquire = async (ownerNonce: string) => {
      const response = await fetch(`${server.address().url}/api/leases/acquire`, {
        method: "POST", headers: headers(token), body: JSON.stringify({ ownerNonce })
      });
      return await response.json() as { id: string; ownerNonce: string };
    };
    const first = await acquire("owner-a");
    const second = await acquire("owner-b");
    const firstHandle = "hud_aaaaaaaaaaaaaaaaaaaa";
    const secondHandle = "hud_bbbbbbbbbbbbbbbbbbbb";
    await fetch(`${server.address().url}/api/events`, {
      method: "POST", headers: headers(token, first.id, first.ownerNonce),
      body: JSON.stringify({ taskId: firstHandle, event: { type: "turn_started" } })
    });
    await fetch(`${server.address().url}/api/events`, {
      method: "POST", headers: headers(token, second.id, second.ownerNonce),
      body: JSON.stringify({ taskId: secondHandle, event: { type: "turn_started" } })
    });

    const eventResponse = await fetch(`${server.address().url}/api/events`, {
      method: "POST", headers: headers(token, first.id, first.ownerNonce),
      body: JSON.stringify({ taskId: firstHandle, event: { type: "activity_seen", category: "tool" } })
    });
    const eventSnapshot = await eventResponse.json() as { revision: number; tasks: Array<{ id: string }> };
    expect(eventSnapshot.tasks.map(({ id }) => id)).toEqual([firstHandle]);

    const selectionResponse = await fetch(`${server.address().url}/api/tasks/${firstHandle}/select`, {
      method: "POST",
      headers: { ...headers(token, first.id, first.ownerNonce), "x-codex-progress-hud-revision": String(eventSnapshot.revision) },
      body: JSON.stringify({ mode: "pinned" })
    });
    const selectionSnapshot = await selectionResponse.json() as { revision: number; tasks: Array<{ id: string }> };
    expect(selectionSnapshot.tasks.map(({ id }) => id)).toEqual([firstHandle]);

    const hookResponse = await fetch(`${server.address().url}/api/hooks/events`, {
      method: "POST",
      headers: { ...headers(token, first.id, first.ownerNonce), "x-codex-progress-hud-revision": String(selectionSnapshot.revision) },
      body: JSON.stringify({
        schemaVersion: 1,
        taskHandle: "hud_cccccccccccccccccccc",
        eventId: "evt_abcdefghijklmnopqrstuvwxyz0123456789",
        sessionKey: "session_abcdefghijklmnopqrstuvwxyz0123456789",
        hook: "Stop",
        receivedAt: 100
      })
    });
    const hookSnapshot = await hookResponse.json() as { tasks: Array<{ id: string }> };
    expect(hookSnapshot.tasks.map(({ id }) => id)).toEqual([
      firstHandle,
      "hud_cccccccccccccccccccc"
    ]);
    expect(JSON.stringify(hookSnapshot)).not.toContain(secondHandle);
    expect(server.leaseStore.boundHandles(first.id, first.ownerNonce)).toEqual([
      firstHandle,
      "hud_cccccccccccccccccccc"
    ]);
  });

  it("rejects an MCP Hook targeting another session's handle with zero mutation", async () => {
    const { server, token } = await fixture();
    const acquire = async (ownerNonce: string) => await (await fetch(
      `${server.address().url}/api/leases/acquire`,
      { method: "POST", headers: headers(token), body: JSON.stringify({ ownerNonce }) }
    )).json() as { id: string; ownerNonce: string };
    const first = await acquire("owner-a");
    const second = await acquire("owner-b");
    const firstHandle = "hud_aaaaaaaaaaaaaaaaaaaa";
    const secondHandle = "hud_bbbbbbbbbbbbbbbbbbbb";
    await fetch(`${server.address().url}/api/events`, {
      method: "POST", headers: headers(token, first.id, first.ownerNonce),
      body: JSON.stringify({ taskId: firstHandle, event: { type: "turn_started" } })
    });
    await fetch(`${server.address().url}/api/events`, {
      method: "POST", headers: headers(token, second.id, second.ownerNonce),
      body: JSON.stringify({ taskId: secondHandle, event: { type: "turn_started" } })
    });
    const before = await (await fetch(`${server.address().url}/api/snapshot`, {
      headers: headers(token)
    })).json();

    const rejected = await fetch(`${server.address().url}/api/hooks/events`, {
      method: "POST",
      headers: { ...headers(token, first.id, first.ownerNonce), "x-codex-progress-hud-revision": String(before.revision) },
      body: JSON.stringify({
        schemaVersion: 1,
        taskHandle: secondHandle,
        eventId: "evt_crosssessionabcdefghijklmnopqrstuvwx",
        sessionKey: "session_crosssessionabcdefghijklmnopqrst",
        hook: "Stop",
        receivedAt: 100
      })
    });

    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "LEASE_FORBIDDEN" });
    expect(await (await fetch(`${server.address().url}/api/snapshot`, {
      headers: headers(token)
    })).json()).toEqual(before);
    expect(server.leaseStore.boundHandles(first.id, first.ownerNonce)).toEqual([firstHandle]);
    expect(server.leaseStore.boundHandles(second.id, second.ownerNonce)).toEqual([secondHandle]);
  });

  it("keeps authenticated Hook-process traffic separate from MCP lease ownership", async () => {
    const { server, token } = await fixture();
    const taskHandle = "hud_aaaaaaaaaaaaaaaaaaaa";
    const response = await fetch(`${server.address().url}/api/hooks/events`, {
      method: "POST",
      headers: { ...headers(token), "x-codex-progress-hud-revision": "0" },
      body: JSON.stringify({
        schemaVersion: 1,
        taskHandle,
        eventId: "evt_hookprocessabcdefghijklmnopqrstuvwxyz",
        sessionKey: "session_hookprocessabcdefghijklmnopqrstuv",
        hook: "UserPromptSubmit",
        receivedAt: 100
      })
    });

    expect(response.status).toBe(202);
    expect((await response.json()).tasks.map(({ id }: { id: string }) => id)).toEqual([taskHandle]);
  });

  it("shuts down after the grace period when a Hook-started companion never receives a lease", async () => {
    let grace!: () => void;
    let delay = 0;
    const { server, token, requestShutdown } = await fixture({
      scheduleTimer: (callback, delayMs) => {
        grace = callback;
        delay = delayMs;
        return "initial-hook-grace";
      }
    });
    const taskHandle = "hud_aaaaaaaaaaaaaaaaaaaa";
    const response = await fetch(`${server.address().url}/api/hooks/events`, {
      method: "POST",
      headers: { ...headers(token), "x-codex-progress-hud-revision": "0" },
      body: JSON.stringify({
        schemaVersion: 1,
        taskHandle,
        eventId: "evt_hookwithoutleaseabcdefghijklmnopqrstu",
        sessionKey: "session_hookwithoutleaseabcdefghijklmnop",
        hook: "SessionStart",
        source: "resume",
        receivedAt: 100
      })
    });

    expect(response.status).toBe(202);
    expect(delay).toBe(30_000);
    grace();
    await new Promise((resolve) => setImmediate(resolve));

    expect(requestShutdown).toHaveBeenCalledOnce();
    const snapshot = await (await fetch(`${server.address().url}/api/snapshot`, {
      headers: headers(token)
    })).json();
    expect(snapshot.selected.task.status).toBe("disconnected_suspected");
  });

  it("cancels the initial Hook grace timer when MCP acquires a lease", async () => {
    let grace!: () => void;
    const cancelled = vi.fn();
    const { server, token, requestShutdown } = await fixture({
      scheduleTimer: (callback) => {
        grace = callback;
        return "initial-hook-grace";
      },
      cancelTimer: cancelled
    });
    await fetch(`${server.address().url}/api/hooks/events`, {
      method: "POST",
      headers: { ...headers(token), "x-codex-progress-hud-revision": "0" },
      body: JSON.stringify({
        schemaVersion: 1,
        taskHandle: "hud_aaaaaaaaaaaaaaaaaaaa",
        eventId: "evt_hookthenleaseabcdefghijklmnopqrstuv",
        sessionKey: "session_hookthenleaseabcdefghijklmnopqr",
        hook: "UserPromptSubmit",
        receivedAt: 100
      })
    });
    const acquired = await fetch(`${server.address().url}/api/leases/acquire`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ ownerNonce: "owner-after-hook" })
    });

    expect(acquired.status).toBe(200);
    expect(cancelled).toHaveBeenCalledWith("initial-hook-grace");
    grace();
    await new Promise((resolve) => setImmediate(resolve));
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it("does not preclaim an unknown control handle before TASK_NOT_FOUND", async () => {
    const { server, token } = await fixture();
    const acquire = async (ownerNonce: string) => {
      const response = await fetch(`${server.address().url}/api/leases/acquire`, {
        method: "POST", headers: headers(token), body: JSON.stringify({ ownerNonce })
      });
      return await response.json() as { id: string; ownerNonce: string };
    };
    const first = await acquire("owner-a");
    const second = await acquire("owner-b");
    const taskHandle = "hud_aaaaaaaaaaaaaaaaaaaa";
    const before = await (await fetch(`${server.address().url}/api/snapshot`, {
      headers: headers(token)
    })).json();

    const missing = await fetch(`${server.address().url}/api/events`, {
      method: "POST", headers: headers(token, first.id, first.ownerNonce),
      body: JSON.stringify({ taskId: taskHandle, event: { type: "tracking_paused" } })
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(server.leaseStore.boundHandles(first.id, first.ownerNonce)).toEqual([]);
    expect(await (await fetch(`${server.address().url}/api/snapshot`, {
      headers: headers(token)
    })).json()).toEqual(before);

    const legitimate = await fetch(`${server.address().url}/api/events`, {
      method: "POST", headers: headers(token, second.id, second.ownerNonce),
      body: JSON.stringify({ taskId: taskHandle, event: { type: "turn_started" } })
    });
    expect(legitimate.status).toBe(202);
    expect(server.leaseStore.boundHandles(second.id, second.ownerNonce)).toEqual([taskHandle]);
  });

  it("returns TASK_NOT_FOUND before any lease expiry transition for an unknown control", async () => {
    let now = 0;
    const leaseStore = new LeaseStore({
      monotonicNow: () => now,
      minTtlMs: 1,
      maxTtlMs: 100,
      defaultTtlMs: 100
    });
    const expired = vi.fn();
    leaseStore.on("expired", expired);
    const { server, token } = await fixture({ leaseStore });
    const active = await (await fetch(`${server.address().url}/api/leases/acquire`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ ownerNonce: "owner-active", ttlMs: 100 })
    })).json() as { id: string; ownerNonce: string };
    await fetch(`${server.address().url}/api/leases/acquire`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ ownerNonce: "owner-expiring", ttlMs: 1 })
    });
    expired.mockClear();
    now = 1;

    const missing = await fetch(`${server.address().url}/api/events`, {
      method: "POST", headers: headers(token, active.id, active.ownerNonce),
      body: JSON.stringify({
        taskId: "hud_aaaaaaaaaaaaaaaaaaaa",
        event: { type: "tracking_stopped" }
      })
    });

    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(expired).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["unsupported", "999"]
  ])("runs only the protocol diagnostic guard before unknown-control %s rejection", async (_name, protocol) => {
    let now = 0;
    const leaseStore = new LeaseStore({
      monotonicNow: () => now,
      minTtlMs: 1,
      maxTtlMs: 100,
      defaultTtlMs: 1
    });
    const expired = vi.fn();
    leaseStore.on("expired", expired);
    const { server, token } = await fixture({ leaseStore });
    const lease = await (await fetch(`${server.address().url}/api/leases/acquire`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ ownerNonce: "owner-a", ttlMs: 1 })
    })).json() as { id: string; ownerNonce: string };
    expired.mockClear();
    now = 1;
    const requestHeaders = headers(token, lease.id, lease.ownerNonce);
    if (protocol === undefined) delete requestHeaders["x-codex-progress-hud-protocol"];
    else requestHeaders["x-codex-progress-hud-protocol"] = protocol;

    const response = await fetch(`${server.address().url}/api/events`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        taskId: "hud_aaaaaaaaaaaaaaaaaaaa",
        event: { type: "tracking_paused" }
      })
    });

    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ code: "VERSION_MISMATCH" });
    expect(expired).not.toHaveBeenCalled();
    const snapshot = await (await fetch(`${server.address().url}/api/snapshot`, {
      headers: headers(token)
    })).json();
    expect(snapshot).toMatchObject({
      revision: 1,
      tasks: [],
      selectedTaskId: null,
      selectionMode: "follow_activity",
      compatibility: { incompatibleClientSeen: true }
    });
  });

  it("rejects explicit binding of a nonexistent task without changing lease state", async () => {
    const { server, token } = await fixture();
    const lease = await (await fetch(`${server.address().url}/api/leases/acquire`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ ownerNonce: "owner-a" })
    })).json() as { id: string; ownerNonce: string };

    const response = await fetch(`${server.address().url}/api/leases/bind`, {
      method: "POST", headers: headers(token, lease.id, lease.ownerNonce),
      body: JSON.stringify({ id: lease.id, ownerNonce: lease.ownerNonce, taskHandle: "hud_aaaaaaaaaaaaaaaaaaaa" })
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(server.leaseStore.boundHandles(lease.id, lease.ownerNonce)).toEqual([]);
  });

  it("removes lease listeners and stops sweeping when the server closes", async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-lease-cleanup-"));
      const leaseStore = new LeaseStore();
      const sweep = vi.spyOn(leaseStore, "sweep");
      const server = createProgressServer({ port: 0, tokenPath: join(directory, "auth.token"), leaseStore });
      await server.listen();
      expect(leaseStore.listenerCount("acquired")).toBe(1);
      expect(leaseStore.listenerCount("released")).toBe(1);
      expect(leaseStore.listenerCount("expired")).toBe(1);
      vi.advanceTimersByTime(1_000);
      const beforeClose = sweep.mock.calls.length;

      await server.close();
      vi.advanceTimersByTime(5_000);

      expect(sweep).toHaveBeenCalledTimes(beforeClose);
      expect(leaseStore.listenerCount("acquired")).toBe(0);
      expect(leaseStore.listenerCount("released")).toBe(0);
      expect(leaseStore.listenerCount("expired")).toBe(0);
      await rm(directory, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
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
