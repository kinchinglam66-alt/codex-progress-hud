import { EventEmitter } from "node:events";
import { randomUUID as nodeRandomUUID } from "node:crypto";

export interface SessionLease {
  id: string;
  ownerNonce: string;
  expiresAt: number;
}

export interface LeaseStoreOptions {
  now?: () => number;
  randomUUID?: () => string;
  minTtlMs?: number;
  maxTtlMs?: number;
  defaultTtlMs?: number;
}

export interface LeaseExpiredEvent {
  lease: SessionLease;
  taskHandles: readonly string[];
}

const DEFAULT_MIN_TTL_MS = 10_000;
const DEFAULT_MAX_TTL_MS = 5 * 60_000;
const DEFAULT_TTL_MS = 60_000;
const OWNER_MAX_LENGTH = 256;
const TASK_HANDLE_PATTERN = /^hud_[A-Za-z0-9_-]{20,96}$/u;

function checkedBound(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function checkedOwner(ownerNonce: string): void {
  if (typeof ownerNonce !== "string" || ownerNonce.trim().length === 0 || ownerNonce.length > OWNER_MAX_LENGTH) {
    throw new TypeError("ownerNonce must be a bounded non-empty string");
  }
}

function checkedHandle(taskHandle: string): void {
  if (!TASK_HANDLE_PATTERN.test(taskHandle)) throw new TypeError("taskHandle is invalid");
}

/** In-memory, capability-scoped leases. Persistence is deliberately avoided so
 * a crashed MCP process cannot resurrect ownership after the companion restarts. */
export class LeaseStore extends EventEmitter {
  readonly #leases = new Map<string, SessionLease>();
  readonly #bindings = new Map<string, Set<string>>();
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #minTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #defaultTtlMs: number;
  #lastNow = 0;

  constructor(options: LeaseStoreOptions = {}) {
    super();
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.#minTtlMs = checkedBound("minTtlMs", options.minTtlMs ?? DEFAULT_MIN_TTL_MS);
    this.#maxTtlMs = checkedBound("maxTtlMs", options.maxTtlMs ?? DEFAULT_MAX_TTL_MS);
    this.#defaultTtlMs = checkedBound("defaultTtlMs", options.defaultTtlMs ?? DEFAULT_TTL_MS);
    if (this.#minTtlMs > this.#maxTtlMs) throw new RangeError("minTtlMs cannot exceed maxTtlMs");
  }

  acquire(ownerNonce: string, ttlMs?: number): SessionLease {
    checkedOwner(ownerNonce);
    const now = this.#safeNow();
    this.sweep(now);
    const lease: SessionLease = {
      id: `lease_${this.#randomUUID()}`,
      ownerNonce,
      expiresAt: now + this.#ttl(ttlMs)
    };
    this.#leases.set(lease.id, lease);
    this.#bindings.set(lease.id, new Set());
    this.emit("acquired", { ...lease });
    this.emit("changed", this.active(now));
    return { ...lease };
  }

  renew(id: string, ownerNonce: string, ttlMs?: number): SessionLease | null {
    checkedOwner(ownerNonce);
    const now = this.#safeNow();
    this.sweep(now);
    const current = this.#leases.get(id);
    if (current === undefined || current.ownerNonce !== ownerNonce) return null;
    const renewed = { ...current, expiresAt: now + this.#ttl(ttlMs) };
    this.#leases.set(id, renewed);
    this.emit("changed", this.active(now));
    return { ...renewed };
  }

  release(id: string, ownerNonce: string): boolean {
    checkedOwner(ownerNonce);
    const now = this.#safeNow();
    this.sweep(now);
    const current = this.#leases.get(id);
    if (current === undefined || current.ownerNonce !== ownerNonce) return false;
    this.#leases.delete(id);
    const taskHandles = [...(this.#bindings.get(id) ?? [])];
    this.#bindings.delete(id);
    this.emit("released", { lease: { ...current }, taskHandles } satisfies LeaseExpiredEvent);
    this.emit("changed", this.active(now));
    return true;
  }

  active(nowMs = this.#safeNow()): readonly SessionLease[] {
    this.sweep(nowMs);
    return [...this.#leases.values()].map((lease) => ({ ...lease }));
  }

  sweep(nowMs = this.#safeNow()): number {
    const now = this.#monotonic(nowMs, "nowMs");
    const expired: LeaseExpiredEvent[] = [];
    for (const [id, lease] of this.#leases) {
      if (lease.expiresAt > now) continue;
      this.#leases.delete(id);
      const taskHandles = [...(this.#bindings.get(id) ?? [])];
      this.#bindings.delete(id);
      expired.push({ lease: { ...lease }, taskHandles });
    }
    for (const event of expired) this.emit("expired", event);
    if (expired.length > 0) this.emit("changed", [...this.#leases.values()].map((lease) => ({ ...lease })));
    return expired.length;
  }

  bind(id: string, ownerNonce: string, taskHandle: string): boolean {
    checkedOwner(ownerNonce);
    checkedHandle(taskHandle);
    this.sweep();
    const lease = this.#leases.get(id);
    if (lease === undefined || lease.ownerNonce !== ownerNonce) return false;
    for (const [otherId, handles] of this.#bindings) {
      if (otherId !== id && handles.has(taskHandle)) return false;
    }
    this.#bindings.get(id)?.add(taskHandle);
    return true;
  }

  authorize(id: string, ownerNonce: string, taskHandle: string): boolean {
    checkedOwner(ownerNonce);
    checkedHandle(taskHandle);
    this.sweep();
    const lease = this.#leases.get(id);
    return lease !== undefined && lease.ownerNonce === ownerNonce &&
      this.#bindings.get(id)?.has(taskHandle) === true;
  }

  boundHandles(id: string, ownerNonce: string): readonly string[] {
    checkedOwner(ownerNonce);
    this.sweep();
    const lease = this.#leases.get(id);
    if (lease === undefined || lease.ownerNonce !== ownerNonce) return [];
    return [...(this.#bindings.get(id) ?? [])];
  }

  has(id: string, ownerNonce: string): boolean {
    checkedOwner(ownerNonce);
    this.sweep();
    const lease = this.#leases.get(id);
    return lease !== undefined && lease.ownerNonce === ownerNonce;
  }

  #ttl(requested: number | undefined): number {
    if (requested !== undefined && (!Number.isFinite(requested) || requested < 0)) {
      throw new RangeError("ttlMs must be a nonnegative finite number");
    }
    return Math.min(this.#maxTtlMs, Math.max(this.#minTtlMs, Math.floor(requested ?? this.#defaultTtlMs)));
  }

  #safeNow(): number {
    return this.#monotonic(this.#now(), "clock");
  }

  #monotonic(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must return a nonnegative safe integer`);
    }
    this.#lastNow = Math.max(this.#lastNow, value);
    return this.#lastNow;
  }
}
