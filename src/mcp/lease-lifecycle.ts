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
  let stopping = false;

  const scheduleRenewal = (): void => {
    if (lease === undefined || stopping) return;
    timer = dependencies.schedule(() => { void renew(); }, Math.max(1, Math.floor(ttlMs / 3)));
  };

  const renew = async (): Promise<void> => {
    const current = lease;
    if (current === undefined || stopping) return;
    try {
      const next = await dependencies.client.renewLease(current, ttlMs);
      if (lease?.id !== current.id || stopping) return;
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
      if (lease !== undefined) return lease;
      const ready = await dependencies.ensureReady("tracking_start");
      if (ready.kind !== "ready") throw failure(ready);
      const acquired = await dependencies.client.acquireLease(dependencies.ownerNonce, ttlMs);
      lease = acquired;
      stopping = false;
      dependencies.client.setLease(acquired);
      scheduleRenewal();
      return acquired;
    },

    async stop(): Promise<void> {
      stopping = true;
      if (timer !== undefined) {
        dependencies.cancel(timer);
        timer = undefined;
      }
      const current = lease;
      lease = undefined;
      dependencies.client.setLease(undefined);
      if (current !== undefined) await dependencies.client.releaseLease(current);
    },

    current(): SessionLease | undefined {
      return lease === undefined ? undefined : { ...lease };
    }
  };
}
