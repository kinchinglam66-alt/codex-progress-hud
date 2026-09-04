import type { EnsureResult, HudWriteReason } from "../lifecycle/types.js";
import type { LeaseClient } from "./report-client.js";
import type { SessionLease } from "../server/lease-store.js";

export interface McpLeaseLifecycleDependencies {
  client: LeaseClient;
  ownerNonce: string;
  ttlMs?: number;
  ensureReady(reason: HudWriteReason): Promise<EnsureResult>;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface McpLeaseLifecycle {
  start(): Promise<SessionLease>;
  stop(): Promise<void>;
  invalidate(expectedLeaseId?: string): void;
  current(): SessionLease | undefined;
}

function failure(result: Exclude<EnsureResult, { kind: "ready" }>): Error {
  return new Error(result.kind === "suppressed" ? result.code : result.code);
}

export function createMcpLeaseLifecycle(
  dependencies: McpLeaseLifecycleDependencies
): McpLeaseLifecycle {
  const ttlMs = dependencies.ttlMs ?? 60_000;
  let lease: SessionLease | undefined;
  let timer: unknown;
  let closed = false;
  let generation = 0;
  let startFlight: { generation: number; promise: Promise<SessionLease> } | undefined;

  const cancelled = (): Error => new Error(closed
    ? "MCP lease lifecycle stopped"
    : "MCP lease acquisition cancelled");

  const cancelRenewal = (): void => {
    if (timer === undefined) return;
    dependencies.cancel(timer);
    timer = undefined;
  };

  const scheduleRenewal = (): void => {
    if (lease === undefined || closed) return;
    const renewalGeneration = generation;
    const leaseId = lease.id;
    timer = dependencies.schedule(
      () => { void renew(renewalGeneration, leaseId); },
      Math.max(1, Math.floor(ttlMs / 3))
    );
  };

  const renew = async (renewalGeneration: number, leaseId: string): Promise<void> => {
    const current = lease;
    timer = undefined;
    if (current === undefined || closed || generation !== renewalGeneration || current.id !== leaseId) return;
    try {
      const next = await dependencies.client.renewLease(current, ttlMs);
      if (lease?.id !== current.id || closed || generation !== renewalGeneration) return;
      lease = next;
      dependencies.client.setLease(next);
      scheduleRenewal();
    } catch {
      // Expiry on the companion is the crash/reachability fallback. Do not
      // manufacture a replacement lease after the owner is no longer known.
      timer = undefined;
    }
  };

  return {
    async start(): Promise<SessionLease> {
      if (closed) throw cancelled();
      if (lease !== undefined) return lease;
      if (startFlight !== undefined) return startFlight.promise;
      const startGeneration = generation;
      const promise = (async (): Promise<SessionLease> => {
        if (closed || generation !== startGeneration) throw cancelled();
        const ready = await dependencies.ensureReady("tracking_start");
        if (closed || generation !== startGeneration) throw cancelled();
        if (ready.kind !== "ready") throw failure(ready);
        const acquired = await dependencies.client.acquireLease(dependencies.ownerNonce, ttlMs);
        if (closed || generation !== startGeneration) {
          await dependencies.client.releaseLease(acquired).catch(() => undefined);
          throw cancelled();
        }
        lease = acquired;
        dependencies.client.setLease(acquired);
        scheduleRenewal();
        return acquired;
      })();
      const flight = { generation: startGeneration, promise };
      startFlight = flight;
      void promise.then(
        () => { if (startFlight === flight) startFlight = undefined; },
        () => { if (startFlight === flight) startFlight = undefined; }
      );
      return promise;
    },

    async stop(): Promise<void> {
      if (closed) return;
      closed = true;
      generation += 1;
      startFlight = undefined;
      cancelRenewal();
      const current = lease;
      lease = undefined;
      dependencies.client.setLease(undefined);
      if (current !== undefined) await dependencies.client.releaseLease(current);
    },

    invalidate(expectedLeaseId?: string): void {
      if (closed) return;
      if (expectedLeaseId !== undefined && lease !== undefined && lease.id !== expectedLeaseId) return;
      generation += 1;
      startFlight = undefined;
      cancelRenewal();
      lease = undefined;
      dependencies.client.setLease(undefined);
    },

    current(): SessionLease | undefined {
      return lease === undefined ? undefined : { ...lease };
    }
  };
}
