/** Trusted-only opt-in for the identity runtime's short-lived cache. */
export interface SessionPreparationPolicy { accountCache?: 'allow' | 'bypass' }

export type AccountAttestationCacheMissReason =
  | 'empty'
  | 'expired'
  | 'wall-clock-rollback'
  | 'monotonic-clock-rollback'
  | 'nonfinite-clock'
  | 'evidence-expired'
  | 'generation-fenced'
  | 'local-guard-failed'
  | 'cancelled'
  | 'publication-rejected'
  | 'explicit';

export interface AccountAttestationCacheDiagnostics {
  candidateCount: number;
  hitCount: number;
  missCount: number;
  localGuardCount: number;
  localGuardMs: number;
  lastMissReason: AccountAttestationCacheMissReason | null;
}

export interface AccountAttestationCacheValue {
  readonly [key: string]: unknown;
}

export interface AccountAttestationCachePublication<T extends AccountAttestationCacheValue> {
  value: T;
  observedAt: number;
  observedMonotonic: number;
  expiresAt: number;
  binding: string;
  metadata: string;
}

export interface AccountAttestationCacheHit<T extends AccountAttestationCacheValue> {
  readonly generation: number;
  readonly value: T;
  readonly observedAt: number;
  readonly observedMonotonic: number;
  readonly expiresAt: number;
  readonly binding: string;
  readonly metadata: string;
}

interface AccountAttestationCacheOptions {
  now: () => number;
  monotonicNow: () => number;
}

interface Entry<T extends AccountAttestationCacheValue> extends AccountAttestationCachePublication<T> {
  readonly generation: number;
}

export const ACCOUNT_ATTESTATION_CACHE_TTL_MS = 30_000;

/**
 * A single-entry, memory-only cache for already-attested identity evidence.
 * The entry is immutable and only the trusted identity runtime receives the
 * value; diagnostics intentionally contain counts and enumerated reasons only.
 */
export function createAccountAttestationCache<T extends AccountAttestationCacheValue>(options: AccountAttestationCacheOptions) {
  let generation = 0;
  let entry: Entry<T> | undefined;
  let lastWall: number | undefined;
  let lastMonotonic: number | undefined;
  const diagnostics: AccountAttestationCacheDiagnostics = {
    candidateCount: 0,
    hitCount: 0,
    missCount: 0,
    localGuardCount: 0,
    localGuardMs: 0,
    lastMissReason: null,
  };

  const recordMiss = (reason: AccountAttestationCacheMissReason): void => {
    diagnostics.missCount++;
    diagnostics.lastMissReason = reason;
  };

  const drop = (reason: AccountAttestationCacheMissReason): void => {
    entry = undefined;
    generation++;
    recordMiss(reason);
  };

  const readClock = (): {wall: number; monotonic: number; reason?: AccountAttestationCacheMissReason} => {
    let wall: number, monotonic: number;
    try {
      wall = options.now();
      monotonic = options.monotonicNow();
    } catch {
      return {wall: Number.NaN, monotonic: Number.NaN, reason: 'nonfinite-clock'};
    }
    if (!Number.isFinite(wall) || !Number.isFinite(monotonic)) return {wall, monotonic, reason: 'nonfinite-clock'};
    if (lastWall !== undefined && wall < lastWall) return {wall, monotonic, reason: 'wall-clock-rollback'};
    if (lastMonotonic !== undefined && monotonic < lastMonotonic) return {wall, monotonic, reason: 'monotonic-clock-rollback'};
    lastWall = wall;
    lastMonotonic = monotonic;
    return {wall, monotonic};
  };

  const expired = (candidate: Entry<T>, clock: {wall: number; monotonic: number}): AccountAttestationCacheMissReason | undefined => {
    if (clock.wall < candidate.observedAt || clock.monotonic < candidate.observedMonotonic) {
      return clock.wall < candidate.observedAt ? 'wall-clock-rollback' : 'monotonic-clock-rollback';
    }
    if (clock.wall >= candidate.expiresAt) return 'evidence-expired';
    if (clock.wall - candidate.observedAt >= ACCOUNT_ATTESTATION_CACHE_TTL_MS ||
      clock.monotonic - candidate.observedMonotonic >= ACCOUNT_ATTESTATION_CACHE_TTL_MS) return 'expired';
    return undefined;
  };

  return {
    generation: (): number => generation,

    publish(publication: AccountAttestationCachePublication<T>, expectedGeneration: number): boolean {
      if (expectedGeneration !== generation) {
        diagnostics.lastMissReason = 'generation-fenced';
        return false;
      }
      const clock = readClock();
      const invalidInput = !Number.isFinite(publication.observedAt) ||
        !Number.isFinite(publication.observedMonotonic) || !Number.isFinite(publication.expiresAt) ||
        publication.observedAt < 0 || publication.observedMonotonic < 0 || publication.expiresAt <= publication.observedAt ||
        !Number.isFinite(publication.observedAt + ACCOUNT_ATTESTATION_CACHE_TTL_MS) ||
        clock.reason !== undefined || clock.wall < publication.observedAt || clock.monotonic < publication.observedMonotonic ||
        clock.wall - publication.observedAt >= ACCOUNT_ATTESTATION_CACHE_TTL_MS ||
        clock.monotonic - publication.observedMonotonic >= ACCOUNT_ATTESTATION_CACHE_TTL_MS ||
        clock.wall >= publication.expiresAt;
      if (invalidInput) {
        diagnostics.lastMissReason = clock.reason ?? (clock.wall >= publication.expiresAt ? 'evidence-expired' : 'publication-rejected');
        return false;
      }
      entry = Object.freeze({...publication, generation});
      return true;
    },

    async acquire(signal: AbortSignal, validateLocal: (value: T, signal: AbortSignal) => Promise<boolean>): Promise<AccountAttestationCacheHit<T> | null> {
      diagnostics.candidateCount++;
      const candidate = entry;
      if (!candidate) {
        recordMiss('empty');
        return null;
      }
      const candidateGeneration = generation;
      const before = readClock();
      const beforeReason = before.reason ?? expired(candidate, before);
      if (beforeReason !== undefined) {
        drop(beforeReason);
        return null;
      }
      if (signal.aborted) {
        drop('cancelled');
        return null;
      }
      diagnostics.localGuardCount++;
      const localGuardStarted=performance.now();
      let valid = false;
      try { valid = await validateLocal(candidate.value, signal); } catch { valid = false; }
      const localGuardElapsed=performance.now()-localGuardStarted;
      if (Number.isFinite(localGuardElapsed) && localGuardElapsed >= 0) diagnostics.localGuardMs+=localGuardElapsed;
      if (!valid || signal.aborted) {
        if (generation === candidateGeneration && entry === candidate) drop(signal.aborted ? 'cancelled' : 'local-guard-failed');
        else recordMiss('generation-fenced');
        return null;
      }
      const after = readClock();
      const afterReason = after.reason ?? expired(candidate, after);
      if (generation !== candidateGeneration || entry !== candidate) {
        recordMiss('generation-fenced');
        return null;
      }
      if (afterReason !== undefined) {
        drop(afterReason);
        return null;
      }
      diagnostics.hitCount++;
      return Object.freeze({generation: candidateGeneration, value: candidate.value, observedAt: candidate.observedAt, observedMonotonic: candidate.observedMonotonic,
        expiresAt: candidate.expiresAt, binding: candidate.binding, metadata: candidate.metadata});
    },

    invalidate(reason: AccountAttestationCacheMissReason = 'explicit'): void {
      entry = undefined;
      generation++;
      diagnostics.lastMissReason = reason;
    },

    diagnostics(): AccountAttestationCacheDiagnostics {
      return Object.freeze({...diagnostics});
    },
  };
}
