import { describe, expect, it } from "vitest";
import type { EnsureResult, HudWriteReason } from "../../src/lifecycle/types.js";
import type { LeaseClient } from "../../src/mcp/report-client.js";
import { createMcpLeaseLifecycle } from "../../src/mcp/lease-lifecycle.js";

describe("MCP lease lifecycle", () => {
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
});
