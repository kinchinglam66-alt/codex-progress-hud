import {expect, it} from 'vitest';
import {createObserverConsentGate} from '../../src/estimation/observer-consent.js';

const proof = {accountFingerprint: 'a'.repeat(64), routeFingerprint: 'b'.repeat(64),
  assetsFingerprint: 'c'.repeat(64), observedAt: 0, expiresAt: 1000};

it('requires explicit current one-use confirmation, not just fresh evidence', () => {
  const gate = createObserverConsentGate({now: () => 0, onInvalidate() {}});
  expect(gate.offer()).toBeNull();
  gate.update(proof);
  expect(gate.authorized()).toBe(false);
  const offer = gate.offer()!;
  expect(gate.accept({...offer})).toBe(false);
  expect(gate.accept(offer)).toBe(true);
  expect(gate.accept(offer)).toBe(false);
  expect(gate.authorized()).toBe(true);
});

it.each(['accountFingerprint'] as const)('invalidates before callback reentry when %s changes', field => {
  const observed: boolean[] = [];
  const gate = createObserverConsentGate({now: () => 0, onInvalidate() {observed.push(gate.authorized());}});
  gate.update(proof); gate.accept(gate.offer()!);
  gate.update({...proof, [field]: 'd'.repeat(64)});
  expect(observed).toEqual([false]);
  expect(gate.authorized()).toBe(false);
});

it('does not invalidate remembered authorization for transient route or asset fingerprints', () => {
  const gate = createObserverConsentGate({now: () => 0, onInvalidate() {throw Error('unexpected');}});
  gate.update(proof); gate.accept(gate.offer()!);
  gate.update({...proof, routeFingerprint: 'd'.repeat(64)});
  gate.update({...proof, assetsFingerprint: 'e'.repeat(64)});
  expect(gate.authorized()).toBe(true);
});

it('rejects stale offers and cannot revive revoked approval with old evidence', () => {
  const gate = createObserverConsentGate({now: () => 0, onInvalidate() {}});
  gate.update(proof); const old = gate.offer()!;
  gate.update({...proof, accountFingerprint: 'd'.repeat(64)});
  expect(gate.accept(old)).toBe(false);
  const current = gate.offer()!;
  gate.revoke(); gate.update(proof);
  expect(gate.accept(current)).toBe(false);
  expect(gate.authorized()).toBe(false);
});

it('retains a fresh same-binding grant but expires at the exact boundary', () => {
  let now = 0, invalidated = 0;
  const gate = createObserverConsentGate({now: () => now, onInvalidate() {invalidated++;}});
  const input = {...proof}; gate.update(input); gate.accept(gate.offer()!);
  input.accountFingerprint = 'd'.repeat(64);
  expect(gate.authorized()).toBe(true);
  now = 500; gate.update({...proof, observedAt: 500, expiresAt: 2000});
  expect(gate.authorized()).toBe(true);
  now = 2000;
  expect(gate.authorized()).toBe(false);
  expect(invalidated).toBe(1);
  expect(gate.authorized()).toBe(false);
  expect(invalidated).toBe(1);
});

it('fails closed on malformed evidence, regressing clock, and invalidation failure', () => {
  let now = 10;
  const gate = createObserverConsentGate({now: () => now, onInvalidate() {throw Error('private');}});
  gate.update(proof); gate.accept(gate.offer()!);
  gate.update(null);
  gate.update(proof);
  expect(gate.offer()).toBeNull();
  const second = createObserverConsentGate({now: () => now, onInvalidate() {}});
  second.update(proof); second.accept(second.offer()!);
  now = 9; expect(second.authorized()).toBe(false);
  now = 10; second.update(proof); expect(second.offer()).toBeNull();
  const third = createObserverConsentGate({now: () => 0, onInvalidate() {}});
  third.update({...proof, expiresAt: 300001}); expect(third.offer()).toBeNull();
  third.update({...proof, observedAt: 1}); expect(third.offer()).toBeNull();
});
