import {expect, it} from 'vitest';
import {initialRecoveryPolicy, reduceRecoveryPolicy, recoveryAdmission, type RecoveryPolicyState} from '../../src/estimation/observer-retry-policy.js';

function failure(state: RecoveryPolicyState, at: number): RecoveryPolicyState {
  return reduceRecoveryPolicy(state, {kind: 'recoverable_failure', at});
}

it('uses literal ten and thirty second retry eligibility before the five minute breaker', () => {
  let state = initialRecoveryPolicy();
  state = failure(state, 0);
  expect(state.nextEligibleAt).toBe(10_000);
  state = failure(state, 10_000);
  expect(state.nextEligibleAt).toBe(40_000);
  state = failure(state, 40_000);
  expect(state.cooldownUntil).toBe(340_000);
  expect(recoveryAdmission(state, 340_000, true)).toMatchObject({allowed: true, kind: 'half_open'});
});

it('allows one eligible half-open attempt and backs off at fifteen then sixty minutes', () => {
  let state = initialRecoveryPolicy();
  state = failure(failure(failure(state, 0), 10_000), 40_000);
  const admitted = recoveryAdmission(state, 340_000, true);
  expect(admitted).toMatchObject({allowed: true, kind: 'half_open'});
  state = reduceRecoveryPolicy(state, {kind: 'half_open_reserved', at: 340_000});
  expect(recoveryAdmission(state, 340_000, true).allowed).toBe(false);
  state = reduceRecoveryPolicy(state, {kind: 'half_open_failure', at: 340_000});
  expect(state.cooldownUntil).toBe(1_240_000);
  state = reduceRecoveryPolicy(state, {kind: 'half_open_failure', at: 1_240_000});
  expect(state.cooldownUntil).toBe(4_840_000);
});

it('opens on three rolling unknown events, retains that history across success, and waits for a real task', () => {
  let state = initialRecoveryPolicy();
  for (const at of [0, 10_000, 20_000]) state = reduceRecoveryPolicy(state, {kind: 'unknown_usage', at});
  expect(state.cooldownUntil).toBe(320_000);
  state = reduceRecoveryPolicy(state, {kind: 'known_success', at: 20_000});
  expect(state.consecutiveFailures).toBe(0);
  expect(state.unknownUsageAt).toEqual([0, 10_000, 20_000]);
  expect(recoveryAdmission(state, 320_000, false)).toMatchObject({allowed: false, reason: 'no_eligible_task'});
});
