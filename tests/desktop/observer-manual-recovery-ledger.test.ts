import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {openReleaseAccounting} from '../../src/estimation/release-accounting.js';
import {createObserverRecoveryController} from '../../src/desktop/observer-recovery.js';

it.each(['disabled', 'unconfirmed', 'binding-changed', 'pending'] as const)('never dispatches through the %s boundary', async (boundary) => {
  const path = await mkdtemp(join(tmpdir(), 'hud-manual-recovery-'));
  const owner = await openReleaseAccounting(path, () => 0);
  let calls = 0;
  let binding = 'original-binding';
  let pending: string | null = null;
  const view = owner.forConversation('fixture');
  try {
    await view.settle((await view.reserve())!, null, 'safe_unknown');
    const controller = createObserverRecoveryController({accounting: owner, runtime: {
      enabled: () => boundary !== 'disabled',
      check: async () => ({binding, closureConfirmed: boundary !== 'unconfirmed'}),
      runTrial: async () => {calls++; return {success: true, closureConfirmed: true,
        usage: {inputTokens: 8, outputTokens: 2, cachedInputTokens: 0}};},
      rebuild: async () => undefined,
    }});
    if (boundary === 'disabled') await expect(controller.preflight()).rejects.toThrow('OBSERVER_RECOVERY_DISABLED');
    else if (boundary === 'unconfirmed') expect((await controller.preflight()).allowed).toBe(false);
    else {
      const preflight = await controller.preflight();
      expect(preflight.allowed).toBe(true);
      if (boundary === 'binding-changed') binding = 'different-binding';
      else pending = await view.reserve();
      await expect(controller.confirm(preflight.revision)).rejects.toThrow();
    }
    expect(calls).toBe(0);
    expect(owner.snapshot().starts).toBe(boundary === 'pending' ? 2 : 1);
    await controller.cancel();
  } finally {
    if (pending) await view.cancelBeforeDispatch(pending);
    await owner.close(); await rm(path, {recursive: true, force: true});
  }
});

// Real controller + SQLite owner; only the external model is replaced.
it.each([0, 300_001])('requires confirmation, runs once and preserves unknown records at %i ms', async (now) => {
  const path = await mkdtemp(join(tmpdir(), 'hud-manual-recovery-'));
  let clock = 0;
  const owner = await openReleaseAccounting(path, () => clock);
  let calls = 0;
  try {
    for (let i = 0; i < 3; i++) {
      const view = owner.forConversation(`failed-${i}`);
      const id = await view.reserve();
      await view.settle(id!, null, 'safe_unknown');
    }
    clock = now;
    const controller = createObserverRecoveryController({accounting: owner, runtime: {
      enabled: () => true,
      check: async () => ({binding: 'synthetic-test-binding', closureConfirmed: true}),
      runTrial: async () => {calls++; return {success: true, closureConfirmed: true,
        usage: {inputTokens: 8, outputTokens: 2, cachedInputTokens: 0}};},
      rebuild: async () => undefined,
    }});
    const before = owner.snapshot();
    const preflight = await controller.preflight();
    expect(preflight.allowed).toBe(true);
    expect(calls).toBe(0);
    expect(owner.snapshot()).toEqual(before);
    await Promise.all([controller.confirm(preflight.revision), controller.confirm(preflight.revision)]);
    expect(calls).toBe(1);
    expect(owner.snapshot()).toMatchObject({unknown: 3, knownTokens: 10, starts: 4, inFlight: 0});
    expect(await owner.recoveryAdmission(clock, true, 'new-task')).toMatchObject({allowed: true, kind: 'ordinary'});
    expect(owner.recoveryStatus().cooldownUntil).toBeNull();
    await controller.cancel();
  } finally {await owner.close(); await rm(path, {recursive: true, force: true});}
});

it.each(['failed', 'unknown', 'unconfirmed', 'enable-failed'] as const)('does not retry or clear cooldown after %s trial', async (outcome) => {
  const path = await mkdtemp(join(tmpdir(), 'hud-manual-recovery-'));
  const owner = await openReleaseAccounting(path, () => 0);
  let calls = 0;
  try {
    for (let i = 0; i < 3; i++) {
      const view = owner.forConversation(`failed-${i}`);
      await view.settle((await view.reserve())!, null, 'safe_unknown');
    }
    const cooldown = owner.recoveryStatus().cooldownUntil;
    const controller = createObserverRecoveryController({accounting: owner, runtime: {
      enabled: () => true,
      check: async () => ({binding: 'synthetic-test-binding', closureConfirmed: true}),
      runTrial: async () => {calls++; return {success: outcome !== 'failed', closureConfirmed: outcome !== 'unconfirmed',
        usage: outcome === 'unknown' ? null : {inputTokens: 8, outputTokens: 2, cachedInputTokens: 0}};},
      rebuild: async () => undefined,
      enable: async () => {
        // Even during scheduler restoration, ordinary admissions stay fenced.
        expect(await owner.forConversation('enable-race').reserve()).toBeNull();
        if (outcome === 'enable-failed') throw new Error('ENABLE_FAILED');
      },
    }});
    const preflight = await controller.preflight();
    expect(preflight.allowed).toBe(true);
    await expect(controller.confirm(preflight.revision)).rejects.toThrow('OBSERVER_RECOVERY_FAILED');
    expect(calls).toBe(1);
    expect(owner.recoveryStatus().cooldownUntil).toBe(cooldown);
    expect((await controller.preflight()).allowed).toBe(false);
    expect(calls).toBe(1);
    expect(owner.snapshot().unknown).toBe(outcome === 'unknown' ? 4 : 3);
    await controller.cancel();
  } finally {await owner.close(); await rm(path, {recursive: true, force: true});}
});
