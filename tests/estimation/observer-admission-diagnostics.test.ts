import {expect, it} from 'vitest';
import {ObserverScheduler, type ObserverWorker} from '../../src/estimation/observer-scheduler.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {ObserverResult} from '../../src/estimation/observer-provider.js';

it.each([
  ['unresolved_previous_call', 'unresolved_previous_call'],
  ['cooldown', 'cooldown'],
  ['unsafe_unknown', 'unsafe_unknown'],
  [undefined, 'local_policy'],
  ['private-provider-error', 'local_policy'],
] as const)('distinguishes a local admission block (%s) from provider quota', async (reason, expected) => {
  let now = 0;
  const contexts = new PassiveContextStore(), goals = new PassiveGoals(contexts);
  const result = {status:'admission_denied', interpretation:null, usage:null, admissionReason:reason} as ObserverResult;
  const worker:ObserverWorker = {
    observe:async()=>result, status:()=>({active:false, disabled:false, poisoned:false}),
    disable:()=>{}, close:async()=>{},
  };
  const scheduler = new ObserverScheduler({contexts,goals,workers:[worker],now:()=>now});
  try {
    const envelope = normalizeHookInput('UserPromptSubmit', {session_id:'local-block',turn_id:'turn'},now,
      'protected-observer-diagnostic-token-123456789').envelope;
    envelope.content={kind:'user',text:'Inspect a local fixture',truncated:false};
    goals.observe(envelope,true,now); contexts.ingest(envelope,now);
    scheduler.changed(envelope.sessionKey,'prompt'); now=15_000; scheduler.tick();
    await Promise.resolve(); await Promise.resolve();
    expect(scheduler.diagnostics(envelope.sessionKey)).toMatchObject({state:'admission_blocked',admissionReason:expected});
    expect(scheduler.stats().disabled).toBe(false);
  } finally {await scheduler.close();}
});
