import { describe, expect, it } from 'vitest';
import { createTurnRouter } from '../../src/server/turn-router.js';
import type { HookEnvelope, HookName } from '../../src/hooks/schema.js';

function event(hook: HookName, turn = 'a', at = 100, overrides: Partial<HookEnvelope> = {}): HookEnvelope {
  return { schemaVersion: 2, taskHandle: `hud_${turn.repeat(24)}`, sessionKey: `session_${'s'.repeat(24)}`,
    turnKey: `turn_${turn.repeat(24)}`, eventId: `evt_${hook}_${turn}_${at}_${'e'.repeat(24)}`,
    hook, receivedAt: at, ...overrides };
}

describe('turn-scoped routing', () => {
  it('rejects same-turn activity after Stop even when received later', () => {
    const router=createTurnRouter();
    router.route(event('UserPromptSubmit','a',100),100);
    router.route(event('Stop','a',200),200);
    expect(router.route(event('PostToolUse','a',300),300).kind).toBe('ignored');
    expect(router.route(event('UserPromptSubmit','a',400),400).kind).toBe('ignored');
    expect(router.route(event('UserPromptSubmit','b',500),500)).toMatchObject({kind:'apply',follow:true});
  });
  it.each(['Stop', 'Interrupt'] as const)('accepts late %s after activity saturation without promoting the old turn', hook => {
    const router = createTurnRouter();
    for (let index = 0; index < 256; index++) {
      expect(router.route(event(index === 0 ? 'UserPromptSubmit' : 'PostToolUse', 'a', index), index))
        .toMatchObject({kind: 'apply'});
    }
    expect(router.route(event('PostToolUse', 'a', 256), 256))
      .toEqual({kind: 'degraded', reason: 'turn_capacity_reached'});
    router.route(event('UserPromptSubmit', 'b', 300), 300);
    const terminal = event(hook, 'a', 200);
    expect(router.route(terminal, 400)).toMatchObject({kind: 'apply', follow: false,
      envelope: {taskId: `hud_${'a'.repeat(24)}`, event: {type: hook === 'Stop' ? 'turn_stopped' : 'runtime_interrupted'}}});
    expect(router.route({...terminal, receivedAt: 500}, 500)).toEqual({kind: 'ignored', reason: 'duplicate'});
    expect(router.route(event('PostToolUse', 'b', 600), 600)).toMatchObject({kind: 'apply', follow: true});
  });

  it('keeps terminal deduplication bounded independently of the full activity fence', () => {
    const router = createTurnRouter();
    for (let index = 0; index < 256; index++) router.route(event(index ? 'PostToolUse' : 'UserPromptSubmit', 'a', index), index);
    expect(router.route(event('Stop', 'a', 300), 300)).toMatchObject({kind: 'apply'});
    expect(router.route(event('Interrupt', 'a', 301), 301)).toMatchObject({kind: 'apply', envelope: {event: {type: 'runtime_interrupted'}}});
    for (let index = 302; index < 602; index++) {
      expect(router.route(event(index % 2 ? 'Stop' : 'Interrupt', 'a', index), index))
        .toEqual({kind: 'ignored', reason: 'duplicate'});
    }
    expect(router.route(event('PostToolUse', 'a', 700), 700)).toEqual({kind: 'ignored', reason: 'duplicate'});
  });

  it('does not promote a tool-attached turn after an intervening newer prompt', () => {
    const router=createTurnRouter();
    router.route(event('UserPromptSubmit','a',100),100);
    router.route(event('PostToolUse','b',200),200);
    router.route(event('UserPromptSubmit','c',300),300);
    expect(router.route(event('UserPromptSubmit','b',150),400)).toMatchObject({kind:'apply',follow:false});
    expect(router.route(event('PostToolUse','c',500),500)).toMatchObject({follow:true});
  });
  it('honors the first prompt for a tool-attached turn without reviving a known old prompt', () => {
    const router = createTurnRouter();
    const first = event('UserPromptSubmit', 'a', 100);
    router.route(first, 100);
    expect(router.route(event('PostToolUse', 'b', 300), 300)).toMatchObject({follow:false});
    expect(router.route(event('UserPromptSubmit', 'b', 200), 400)).toMatchObject({
      kind:'apply',follow:true,lateAttached:true,orderingUncertain:true
    });
    expect(router.route({...first,receivedAt:500},500)).toMatchObject({kind:'ignored'});
    expect(router.route(event('PostToolUse','a',600),600)).toMatchObject({follow:false});
    expect(router.route(event('PostToolUse','b',700),700)).toMatchObject({follow:true});
  });
  it.each(['Stop', 'Interrupt'] as const)('preserves distinct delayed %s evidence for its exact turn', hook => {
    const router = createTurnRouter();
    router.route(event('UserPromptSubmit', 'a', 100), 100);
    router.route(event('PostToolUse', 'a', 300), 300);
    router.route(event('UserPromptSubmit', 'b', 350), 350);
    const delayed = event(hook, 'a', 200);
    expect(router.route(delayed, 400)).toMatchObject({ kind: 'apply', follow: false });
    expect(router.route(delayed, 450)).toMatchObject({ kind: 'ignored', reason: 'duplicate' });
    expect(router.route(event('PostToolUse', 'a', 250), 500)).toMatchObject({ kind: 'ignored' });
  });

  it('routes a distinct prompt to a new task while an old stop retains its original target', () => {
    const router = createTurnRouter();
    expect(router.route(event('UserPromptSubmit'), 100)).toMatchObject({ kind: 'apply', follow: true,
      lateAttached: false, envelope: { taskId: `hud_${'a'.repeat(24)}`, event: { type: 'turn_started' } } });
    expect(router.route(event('UserPromptSubmit', 'b', 200), 200)).toMatchObject({ kind: 'apply', follow: true, orderingUncertain: true });
    expect(router.route(event('Stop', 'a', 300), 300)).toMatchObject({ kind: 'apply', follow: false,
      envelope: { taskId: `hud_${'a'.repeat(24)}`, event: { type: 'turn_stopped' } } });
  });

  it('ignores a repeated prompt even when its receipt time changes', () => {
    const router = createTurnRouter();
    const prompt = event('UserPromptSubmit');
    expect(router.route(prompt, 100)).toMatchObject({ kind: 'apply' });
    expect(router.route({ ...prompt, receivedAt: 200 }, 200)).toEqual({ kind: 'ignored', reason: 'duplicate' });
  });

  it.each(['Stop', 'Interrupt', 'PostToolUse', 'UserPromptSubmit'] as const)('does not infer a turn for unkeyed %s', hook => {
    const router = createTurnRouter();
    router.route(event('UserPromptSubmit'), 100);
    const unkeyed = event(hook, 'a', 200);
    delete unkeyed.turnKey;
    expect(router.route(unkeyed, 200)).toEqual({ kind: 'degraded', reason: 'turn_identity_unavailable' });
  });

  it.each(['Stop', 'Interrupt'] as const)('does not create an unknown turn from %s', hook => {
    expect(createTurnRouter().route(event(hook), 100)).toEqual({ kind: 'degraded', reason: 'turn_order_unknown' });
  });

  it('late-attaches observed tool activity without inventing an earlier start', () => {
    expect(createTurnRouter().route(event('PostToolUse', 'a', 500), 500)).toMatchObject({
      kind: 'apply', lateAttached: true, envelope: { event: { type: 'activity_seen' } }
    });
  });

  it.each(['SessionStart', 'SessionEnd'] as const)('treats %s as session evidence, not a new task', hook => {
    expect(createTurnRouter().route(event(hook), 100)).toEqual({
      kind: 'session', sessionKey: `session_${'s'.repeat(24)}`, ended: hook === 'SessionEnd'
    });
  });

  it('rejects one handle claiming a different session or turn', () => {
    const router = createTurnRouter();
    router.route(event('UserPromptSubmit'), 100);
    expect(router.route(event('PostToolUse', 'a', 200, { turnKey: `turn_${'b'.repeat(24)}` }), 200))
      .toEqual({ kind: 'degraded', reason: 'turn_identity_conflict' });
    expect(router.route(event('PostToolUse', 'a', 300, { sessionKey: `session_${'x'.repeat(24)}` }), 300))
      .toEqual({ kind: 'degraded', reason: 'turn_identity_conflict' });
  });

  it('rejects a second handle claiming a known session/turn pair', () => {
    const router = createTurnRouter();
    router.route(event('UserPromptSubmit'), 100);
    expect(router.route(event('PostToolUse', 'a', 200, { taskHandle: `hud_${'b'.repeat(24)}` }), 200))
      .toEqual({ kind: 'degraded', reason: 'turn_identity_conflict' });
  });

  it('never uses receipt time to extend expired identity retention', () => {
    const router = createTurnRouter({ retentionMs: 100 });
    router.route(event('UserPromptSubmit', 'a', 100), 100);
    router.observeTerminal(event('UserPromptSubmit').taskHandle, 100);
    expect(router.route(event('PostToolUse', 'a', 100), 201)).toEqual({ kind: 'ignored', reason: 'expired_turn' });
    expect(router.route(event('UserPromptSubmit', 'a', 300), 300)).toEqual({ kind: 'ignored', reason: 'expired_turn' });
  });

  it('does not expire a waiting active turn merely because there was no activity', () => {
    const router = createTurnRouter({ retentionMs: 100 });
    router.route(event('UserPromptSubmit'), 100);
    expect(router.route(event('PostToolUse', 'a', 1000), 1000)).toMatchObject({ kind: 'apply' });
  });

  it('fails closed at the identity cap without forgetting existing fencing', () => {
    const router = createTurnRouter({ maxTurns: 1 });
    router.route(event('UserPromptSubmit'), 100);
    expect(router.route(event('UserPromptSubmit', 'b', 200), 200)).toEqual({ kind: 'degraded', reason: 'turn_capacity_reached' });
    expect(router.route(event('Stop', 'a', 300), 300)).toMatchObject({ kind: 'apply', follow: true });
  });

  it('does not treat an older receipt as newer activity', () => {
    const router = createTurnRouter();
    expect(router.route(event('UserPromptSubmit', 'a', 200), 200)).toMatchObject({ kind: 'apply' });
    expect(router.route(event('PostToolUse', 'a', 100), 300)).toEqual({ kind: 'ignored', reason: 'duplicate' });
  });

  it('rejects unsafe clocks and limits before routing', () => {
    expect(() => createTurnRouter({ maxTurns: 0 })).toThrow();
    expect(() => createTurnRouter({ retentionMs: -1 })).toThrow();
    expect(() => createTurnRouter().route(event('Stop', 'a', 200), 100)).toThrow();
    expect(() => createTurnRouter().route(event('Stop'), Number.NaN)).toThrow();
  });
});
