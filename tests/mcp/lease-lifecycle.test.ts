import { describe, expect, it, vi } from "vitest";
import type { EnsureResult, HudWriteReason } from "../../src/lifecycle/types.js";
import type { LeaseClient } from "../../src/mcp/report-client.js";
import { createMcpLeaseLifecycle } from "../../src/mcp/lease-lifecycle.js";

describe("MCP lease lifecycle", () => {
  it("aborts in-flight readiness when the connection stops", async () => {
    let signal: AbortSignal | undefined;
    let finish!: (value: EnsureResult) => void;
    const lifecycle = createMcpLeaseLifecycle({
      client: { acquireLease: async () => { throw new Error("no acquisition"); }, renewLease: async lease => lease, releaseLease: async () => undefined, bindLease: async () => undefined, setLease: () => undefined, setLeaseOwnerNonce: () => undefined },
      ownerNonce: "owner",
      ensureReady: async (_reason, options) => { signal = options?.signal; return new Promise(r => { finish = r; }); },
      schedule: () => 1, cancel: () => undefined
    });
    const starting = lifecycle.start();
    const rejected = expect(starting).rejects.toThrow("stopped");
    await lifecycle.stop();
    finish({ kind: "suppressed", code: "MANUALLY_DISABLED" });
    await rejected;
    expect(signal?.aborted).toBe(true);
  });
  it("clears a failed renewal so a living connection can reacquire", async () => {
    let timer!: () => void;
    let acquisitions = 0;
    const lifecycle = createMcpLeaseLifecycle({
      client: {
        acquireLease: async () => ({ id: `lease_${++acquisitions}`, ownerNonce: "a", expiresAt: 60000 }),
        renewLease: async () => { throw new Error("offline"); },
        releaseLease: async () => undefined, bindLease: async () => undefined,
        setLease: () => undefined, setLeaseOwnerNonce: () => undefined
      },
      ownerNonce: "a",
      ensureReady: async () => ({ kind: "ready", generation: 0, snapshot: { observedState: "running" } }),
      schedule: callback => { timer = callback; return 1; }, cancel: () => undefined
    });
    await lifecycle.start(); timer(); await Promise.resolve(); await Promise.resolve();
    expect(lifecycle.current()).toBeUndefined();
    await lifecycle.start();
    expect(acquisitions).toBe(2);
    await lifecycle.stop();
  });
  it("acquires after readiness, renews below half TTL, and releases once", async () => {
    let timer: (() => void) | undefined;
    const acquired = { id: "lease_a", ownerNonce: "owner-a", expiresAt: 60_000 };
    const renewed = { ...acquired, expiresAt: 90_000 };
    const client: LeaseClient = {
      acquireLease: async () => acquired,
      renewLease: async () => renewed,
      releaseLease: async () => undefined,
      bindLease: async () => undefined,
      setLease: () => undefined,
      setLeaseOwnerNonce: () => undefined
    };
    const calls: string[] = [];
    const lifecycle = createMcpLeaseLifecycle({
      client,
      ownerNonce: "owner-a",
      ttlMs: 60_000,
      ensureReady: async (_reason: HudWriteReason): Promise<EnsureResult> => {
        calls.push("ready");
        return { kind: "ready", generation: 1, snapshot: { observedState: "running" } };
      },
      schedule: (callback) => { timer = callback; return 1; },
      cancel: () => { calls.push("cancel"); }
    });

    await lifecycle.start();
    expect(calls).toEqual(["ready"]);
    expect(lifecycle.current()).toEqual(acquired);
    timer!();
    await Promise.resolve();
    expect(lifecycle.current()).toEqual(renewed);

    await lifecycle.stop();
    await lifecycle.stop();
    expect(calls).toEqual(["ready", "cancel"]);
  });

  it("does not acquire a lease when the companion cannot become ready", async () => {
    let acquireCalls = 0;
    const lifecycle = createMcpLeaseLifecycle({
      client: {
        acquireLease: async () => { acquireCalls += 1; throw new Error("must not acquire"); },
        renewLease: async () => { throw new Error("unused"); },
        releaseLease: async () => undefined,
        bindLease: async () => undefined,
        setLease: () => undefined,
        setLeaseOwnerNonce: () => undefined
      },
      ownerNonce: "owner-a",
      ensureReady: async () => ({ kind: "error", code: "START_TIMEOUT", snapshot: { observedState: "stopped" } }),
      schedule: () => 1,
      cancel: () => undefined
    });

    await expect(lifecycle.start()).rejects.toThrow("START_TIMEOUT");
    expect(acquireCalls).toBe(0);
  });

  it("never acquires after stop wins while readiness is pending", async () => {
    let resolveReady!: (value: EnsureResult) => void;
    const ready = new Promise<EnsureResult>((resolve) => { resolveReady = resolve; });
    const acquireLease = vi.fn(async () => ({ id: "lease_late", ownerNonce: "owner-a", expiresAt: 60_000 }));
    const setLease = vi.fn();
    const lifecycle = createMcpLeaseLifecycle({
      client: {
        acquireLease,
        renewLease: async (lease) => lease,
        releaseLease: async () => undefined,
        bindLease: async () => undefined,
        setLease,
        setLeaseOwnerNonce: () => undefined
      },
      ownerNonce: "owner-a",
      ensureReady: async () => ready,
      schedule: () => 1,
      cancel: () => undefined
    });

    const starting = lifecycle.start();
    await Promise.resolve();
    await lifecycle.stop();
    resolveReady({ kind: "ready", generation: 1, snapshot: { observedState: "running" } });

    await expect(starting).rejects.toThrow(/stopped|cancelled/iu);
    expect(acquireLease).not.toHaveBeenCalled();
    expect(setLease).not.toHaveBeenCalledWith(expect.objectContaining({ id: "lease_late" }));
    expect(lifecycle.current()).toBeUndefined();
  });

  it("releases an acquisition that settles after stop and never schedules renewal", async () => {
    let resolveAcquire!: (value: { id: string; ownerNonce: string; expiresAt: number }) => void;
    const acquisition = new Promise<{ id: string; ownerNonce: string; expiresAt: number }>((resolve) => {
      resolveAcquire = resolve;
    });
    const releaseLease = vi.fn(async () => undefined);
    const schedule = vi.fn(() => 1);
    const setLease = vi.fn();
    const lifecycle = createMcpLeaseLifecycle({
      client: {
        acquireLease: async () => acquisition,
        renewLease: async (lease) => lease,
        releaseLease,
        bindLease: async () => undefined,
        setLease,
        setLeaseOwnerNonce: () => undefined
      },
      ownerNonce: "owner-a",
      ensureReady: async () => ({ kind: "ready", generation: 1, snapshot: { observedState: "running" } }),
      schedule,
      cancel: () => undefined
    });

    const starting = lifecycle.start();
    await Promise.resolve();
    await Promise.resolve();
    await lifecycle.stop();
    const lateLease = { id: "lease_late", ownerNonce: "owner-a", expiresAt: 60_000 };
    resolveAcquire(lateLease);

    await expect(starting).rejects.toThrow(/stopped|cancelled/iu);
    expect(releaseLease).toHaveBeenCalledWith(lateLease);
    expect(schedule).not.toHaveBeenCalled();
    expect(setLease).not.toHaveBeenCalledWith(lateLease);
    expect(lifecycle.current()).toBeUndefined();
  });

  it("single-flights concurrent starts and cancels renewal work on stop", async () => {
    let resolveAcquire!: (value: { id: string; ownerNonce: string; expiresAt: number }) => void;
    const acquisition = new Promise<{ id: string; ownerNonce: string; expiresAt: number }>((resolve) => {
      resolveAcquire = resolve;
    });
    const acquireLease = vi.fn(async () => acquisition);
    let renewal!: () => void;
    const renewLease = vi.fn(async (lease) => lease);
    const cancel = vi.fn();
    const lifecycle = createMcpLeaseLifecycle({
      client: {
        acquireLease,
        renewLease,
        releaseLease: async () => undefined,
        bindLease: async () => undefined,
        setLease: () => undefined,
        setLeaseOwnerNonce: () => undefined
      },
      ownerNonce: "owner-a",
      ensureReady: async () => ({ kind: "ready", generation: 1, snapshot: { observedState: "running" } }),
      schedule: (callback) => { renewal = callback; return "timer"; },
      cancel
    });

    const first = lifecycle.start();
    const second = lifecycle.start();
    await Promise.resolve();
    const lease = { id: "lease_one", ownerNonce: "owner-a", expiresAt: 60_000 };
    resolveAcquire(lease);
    await expect(Promise.all([first, second])).resolves.toEqual([lease, lease]);
    expect(acquireLease).toHaveBeenCalledOnce();

    await lifecycle.stop();
    renewal();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(renewLease).not.toHaveBeenCalled();
    await expect(lifecycle.start()).rejects.toThrow(/stopped|closed/iu);
    expect(acquireLease).toHaveBeenCalledOnce();
  });

  it("cancels a stale start generation before a replacement acquisition is installed", async () => {
    let resolveFirst!: (value: { id: string; ownerNonce: string; expiresAt: number }) => void;
    const firstAcquisition = new Promise<{ id: string; ownerNonce: string; expiresAt: number }>((resolve) => {
      resolveFirst = resolve;
    });
    const replacement = { id: "lease_new", ownerNonce: "owner-a", expiresAt: 90_000 };
    const releaseLease = vi.fn(async () => undefined);
    const acquireLease = vi.fn()
      .mockImplementationOnce(async () => firstAcquisition)
      .mockResolvedValueOnce(replacement);
    const lifecycle = createMcpLeaseLifecycle({
      client: {
        acquireLease,
        renewLease: async (lease) => lease,
        releaseLease,
        bindLease: async () => undefined,
        setLease: () => undefined,
        setLeaseOwnerNonce: () => undefined
      },
      ownerNonce: "owner-a",
      ensureReady: async () => ({ kind: "ready", generation: 1, snapshot: { observedState: "running" } }),
      schedule: () => 1,
      cancel: () => undefined
    });

    const stale = lifecycle.start();
    await Promise.resolve();
    lifecycle.invalidate();
    const current = lifecycle.start();
    await expect(current).resolves.toEqual(replacement);
    const staleLease = { id: "lease_old", ownerNonce: "owner-a", expiresAt: 60_000 };
    resolveFirst(staleLease);

    await expect(stale).rejects.toThrow(/cancelled/iu);
    expect(releaseLease).toHaveBeenCalledWith(staleLease);
    expect(lifecycle.current()).toEqual(replacement);
  });
});
