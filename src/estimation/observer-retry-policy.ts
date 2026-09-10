// The third failure trips the five-minute circuit; there is no third retry.
export const RETRY_DELAYS_MS = Object.freeze([10_000, 30_000]);
export const COOLDOWN_DELAYS_MS = Object.freeze([300_000, 900_000, 3_600_000]);
export const UNKNOWN_WINDOW_MS = 3_600_000;

export interface RecoveryPolicyState {
  consecutiveFailures: number;
  unknownUsageAt: readonly number[];
  nextEligibleAt: number | null;
  cooldownUntil: number | null;
  cooldownLevel: 0 | 1 | 2;
  halfOpenReserved: boolean;
}
export type RecoveryPolicyEvent =
  | {kind: 'recoverable_failure'; at: number}
  | {kind: 'unknown_usage'; at: number}
  | {kind: 'known_success'; at: number}
  | {kind: 'half_open_reserved'; at: number}
  | {kind: 'half_open_failure'; at: number}
  | {kind: 'half_open_success'; at: number};
export type RecoveryAdmission = {allowed: boolean; kind: 'ordinary' | 'retry' | 'half_open'; nextEligibleAt: number | null; reason?: 'cooldown' | 'retry_backoff' | 'no_eligible_task' | 'half_open_busy'};

export function initialRecoveryPolicy(): RecoveryPolicyState {
  return {consecutiveFailures: 0, unknownUsageAt: [], nextEligibleAt: null, cooldownUntil: null, cooldownLevel: 0, halfOpenReserved: false};
}
function validAt(at: number): number { if (!Number.isSafeInteger(at) || at < 0) throw new Error('OBSERVER_RECOVERY_CLOCK'); return at; }
function pruneUnknown(at: number, values: readonly number[]): number[] { return values.filter(value => at - value < UNKNOWN_WINDOW_MS); }

export function reduceRecoveryPolicy(previous: RecoveryPolicyState, event: RecoveryPolicyEvent): RecoveryPolicyState {
  const at = validAt(event.at);
  const state = {...previous, unknownUsageAt: pruneUnknown(at, previous.unknownUsageAt)};
  if (event.kind === 'recoverable_failure') {
    const failures = Math.min(3, state.consecutiveFailures + 1);
    if (state.halfOpenReserved) return {...state, halfOpenReserved: false, cooldownUntil: at + COOLDOWN_DELAYS_MS[Math.min(2, state.cooldownLevel + 1)]!, cooldownLevel: Math.min(2, state.cooldownLevel + 1) as 0|1|2, nextEligibleAt: null};
    if (failures >= 3) return {...state, consecutiveFailures: failures, cooldownUntil: at + COOLDOWN_DELAYS_MS[0]!, nextEligibleAt: null};
    return {...state, consecutiveFailures: failures, nextEligibleAt: at + RETRY_DELAYS_MS[failures - 1]!};
  }
  if (event.kind === 'unknown_usage') {
    const unknownUsageAt = [...state.unknownUsageAt, at];
    return unknownUsageAt.length >= 3 ? {...state, unknownUsageAt, cooldownUntil: at + COOLDOWN_DELAYS_MS[0]!, nextEligibleAt: null} : {...state, unknownUsageAt};
  }
  if (event.kind === 'known_success') return {...state, consecutiveFailures: 0, nextEligibleAt: null};
  if (event.kind === 'half_open_reserved') return {...state, halfOpenReserved: true};
  if (event.kind === 'half_open_failure') return {...state, halfOpenReserved: false, cooldownUntil: at + COOLDOWN_DELAYS_MS[Math.min(2, state.cooldownLevel + 1)]!, cooldownLevel: Math.min(2, state.cooldownLevel + 1) as 0|1|2, nextEligibleAt: null};
  return {...state, halfOpenReserved: false, consecutiveFailures: 0, cooldownUntil: null, nextEligibleAt: null};
}

export function recoveryAdmission(state: RecoveryPolicyState, now: number, eligibleTask: boolean): RecoveryAdmission {
  validAt(now);
  if (!eligibleTask) return {allowed: false, kind: 'ordinary', nextEligibleAt: state.cooldownUntil ?? state.nextEligibleAt, reason: 'no_eligible_task'};
  if (state.halfOpenReserved) return {allowed: false, kind: 'half_open', nextEligibleAt: state.cooldownUntil, reason: 'half_open_busy'};
  if (state.cooldownUntil !== null) {
    if (now < state.cooldownUntil) return {allowed: false, kind: 'half_open', nextEligibleAt: state.cooldownUntil, reason: 'cooldown'};
    return {allowed: true, kind: 'half_open', nextEligibleAt: null};
  }
  if (state.nextEligibleAt !== null && now < state.nextEligibleAt) return {allowed: false, kind: 'retry', nextEligibleAt: state.nextEligibleAt, reason: 'retry_backoff'};
  return {allowed: true, kind: state.consecutiveFailures > 0 ? 'retry' : 'ordinary', nextEligibleAt: null};
}
