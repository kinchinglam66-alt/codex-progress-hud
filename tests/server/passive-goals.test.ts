import {describe, expect, it} from 'vitest';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput, type HookName} from '../../src/hooks/schema.js';

const key = 'protected-goal-owner-test-token-1234567890';
function fixture() {
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts);
  let counter = 0;
  let sessionKey = '';
  const hook = (hook: HookName, now: number, turn = 'one', follow = true, session = 'session') => {
    const envelope = normalizeHookInput(hook, {session_id: session, turn_id: turn,
      tool_use_id: String(++counter)}, now, key).envelope;
    if (hook === 'UserPromptSubmit') envelope.content = {kind: 'user', text: `PRIVATE ${turn}`, truncated: false};
    if (hook === 'PostToolUse') envelope.content = {kind: 'tool', text: 'tool result', truncated: false};
    if (hook === 'Stop') envelope.content = {kind: 'assistant', text: 'final response', truncated: false};
    contexts.ingest(envelope, now);
    goals.observe(envelope, follow, now);
    sessionKey = envelope.sessionKey;
    return sessionKey;
  };
  const request = (now: number) => {
    const result = goals.request(sessionKey, now);
    expect(result).not.toBeNull();
    return result!;
  };
  return {goals, contexts, hook, request};
}
const answer = (relation: 'replace'|'continue' = 'replace') => ({relation, status: 'running',
  summary: 'PRIVATE current goal', estimate: {remainingSeconds: 3600, errorPercent: 30}});

describe('passive goal interpretation owner', () => {
  it('bootstraps an ongoing goal from a first continuation with a summary', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    f.hook('PostToolUse', 1000);
    expect(f.goals.settle(f.request(15000).ticket, answer('continue'), 28000)).toBe(true);
    expect(f.goals.view(session, 28000)).toMatchObject({generation: 1, status: 'running',
      prediction: {remainingSeconds: 3600, observedActiveSeconds: 15}});
    expect(f.request(29000).input.goalSummary).toBe('PRIVATE current goal');
  });

  it('rejects first continuations without a summary and stale bootstrap replies', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    expect(f.goals.settle(f.request(15000).ticket, {...answer('continue'), summary: null}, 16000)).toBe(false);
    const stale = f.request(17000);
    f.hook('UserPromptSubmit', 18000, 'two');
    expect(f.goals.settle(stale.ticket, answer('continue'), 19000)).toBe(false);
    expect(f.goals.view(session, 19000)?.prediction).toBeNull();
  });

  it('advances the estimate revision only for accepted observer answers', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    expect(f.goals.view(session, 0)?.estimateRevision).toBe(0);
    const ticket = f.request(15000).ticket;
    expect(f.goals.settle(ticket, answer(), 16000)).toBe(true);
    expect(f.goals.view(session, 16000)?.estimateRevision).toBe(1);
    f.hook('PostToolUse', 17000);
    expect(f.goals.view(session, 18000)?.estimateRevision).toBe(1);
    expect(f.goals.settle(ticket, answer(), 19000)).toBe(false);
    expect(f.goals.view(session, 19000)?.estimateRevision).toBe(1);
    expect(f.goals.settle(f.request(20000).ticket, answer('continue'), 21000)).toBe(true);
    expect(f.goals.view(session, 21000)?.estimateRevision).toBe(2);
  });

  it('does not let another conversation or a read advance the lifecycle fence', () => {
    const f = fixture(); const first = f.hook('UserPromptSubmit', 1000);
    f.hook('UserPromptSubmit', 5000, 'one', true, 'second');
    f.goals.view('absent', 9000);
    f.goals.view(first, 10000);
    f.hook('Stop', 4000);
    expect(f.goals.view(first, 11000)).toMatchObject({runtime: 'waiting', activeSeconds: 3});
  });

  it('does not exhaust new goal admission with unrelated session endings', () => {
    const f = fixture(); const ended = f.hook('UserPromptSubmit', 0);
    f.goals.end(ended);
    for (let index = 0; index < 5000; index++) f.goals.end(`unrelated-${index}`);
    f.hook('PostToolUse', 1000);
    expect(f.goals.view(ended, 2000)).toBeNull();
    const fresh = f.hook('UserPromptSubmit', 3000, 'one', true, 'fresh');
    expect(f.goals.view(fresh, 4000)).not.toBeNull();
  });

  it('bounds recent ended-session fences without disabling fresh goal admission', () => {
    const f = fixture();
    let recent = '';
    for (let index = 0; index < 4100; index++) {
      recent = f.hook('UserPromptSubmit', index, 'one', true, `closed-${index}`);
      f.goals.end(recent);
    }
    f.hook('PostToolUse', 5000, 'one', true, 'closed-4099');
    expect(f.goals.view(recent, 6000)).toBeNull();
    const fresh = f.hook('UserPromptSubmit', 7000, 'one', true, 'fresh-after-cap');
    expect(f.goals.view(fresh, 8000)).not.toBeNull();
  });

  it('rejects a response timestamp preceding its own request', () => {
    const f = fixture(); f.hook('UserPromptSubmit', 0);
    expect(f.goals.settle(f.request(10000).ticket, answer(), 9000)).toBe(false);
  });

  it('keeps early tool work when the first prompt is delivered late', () => {
    const f = fixture(); const session = f.hook('PostToolUse', 0);
    f.hook('UserPromptSubmit', 10000);
    expect(f.goals.settle(f.request(15000).ticket, answer(), 16000)).toBe(true);
    expect(f.goals.view(session, 20000)?.activeSeconds).toBe(20);
  });

  it('freezes explicit pauses and rejects model completion after runtime failure', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    const turnKey = normalizeHookInput('UserPromptSubmit', {session_id: 'session', turn_id: 'one'}, 0, key).envelope.turnKey!;
    f.goals.runtime(session, turnKey, 'paused', 10000);
    f.hook('PostToolUse', 15000);
    expect(f.goals.view(session, 20000)).toMatchObject({status: 'paused', activeSeconds: 10});
    f.goals.runtime(session, turnKey, 'running', 25000);
    expect(f.goals.view(session, 30000)?.activeSeconds).toBe(15);
    const request = f.request(30000);
    f.goals.runtime(session, turnKey, 'failed', 31000);
    expect(f.goals.settle(request.ticket, {...answer(), status: 'completed', estimate: null}, 32000)).toBe(false);
    expect(f.goals.view(session, 40000)).toMatchObject({status: 'failed', activeSeconds: 16});
  });

  it('keeps identity local and never exposes goal text in its display view', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    f.hook('PostToolUse', 1000);
    const request = f.request(15000);
    expect(request.input.messages.map(message => message.text)).toEqual(['PRIVATE one', 'tool result']);
    expect(JSON.stringify(request.input)).not.toContain(session);
    expect(request.input).not.toHaveProperty('ticket');
    expect(f.goals.settle(request.ticket, answer(), 16000)).toBe(true);
    const view = f.goals.view(session, 20000);
    expect(view).toMatchObject({generation: 1, activeSeconds: 20, status: 'running',
      prediction: {remainingSeconds: 3600, errorPercent: 30, observedActiveSeconds: 15}});
    expect(JSON.stringify(view)).not.toContain('PRIVATE');
  });

  it('counts active work across continuation but resets it on replacement', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    f.hook('PostToolUse', 1000);
    expect(f.goals.settle(f.request(5000).ticket, answer(), 5000)).toBe(true);
    f.hook('Stop', 10000);
    expect(f.goals.view(session, 25000)?.activeSeconds).toBe(10);
    f.hook('UserPromptSubmit', 30000, 'two');
    const continuing = f.request(35000);
    expect(continuing.input.goalSummary).toBe('PRIVATE current goal');
    expect(f.goals.settle(continuing.ticket, answer('continue'), 35000)).toBe(true);
    expect(f.goals.view(session, 35000)).toMatchObject({generation: 1, activeSeconds: 15});
    f.hook('UserPromptSubmit', 40000, 'three');
    expect(f.goals.settle(f.request(45000).ticket, {...answer(), summary: 'NEW goal'}, 45000)).toBe(true);
    expect(f.goals.view(session, 45000)).toMatchObject({generation: 2, activeSeconds: 5});
    expect(f.request(46000).input.goalSummary).toBe('NEW goal');
  });

  it('rejects a response from before a new prompt and rejects ticket replay', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    const old = f.request(15000);
    f.hook('UserPromptSubmit', 20000, 'two');
    expect(f.goals.settle(old.ticket, answer(), 25000)).toBe(false);
    const current = f.request(25000);
    expect(f.goals.settle(current.ticket, answer(), 26000)).toBe(true);
    expect(f.goals.settle(current.ticket, answer(), 27000)).toBe(false);
    expect(f.goals.view(session, 27000)?.generation).toBe(1);
  });

  it('accepts an ETA despite newer same-turn tools but not after interruption', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    const request = f.request(15000);
    f.hook('PostToolUse', 16000);
    expect(f.goals.settle(request.ticket, answer(), 17000)).toBe(true);
    const interrupted = f.request(18000);
    f.hook('Interrupt', 19000);
    expect(f.goals.settle(interrupted.ticket, {...answer('continue'), status: 'completed', estimate: null}, 20000)).toBe(false);
    expect(f.goals.view(session, 21000)).toMatchObject({status: 'interrupted', activeSeconds: 19});
    expect(f.goals.request(session, 22000)).toBeNull();
  });

  it('does not infer completion from Stop or estimated zero', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    expect(f.goals.settle(f.request(1000).ticket, {...answer(), estimate: {remainingSeconds: 0, errorPercent: 50}}, 1000)).toBe(true);
    expect(f.goals.view(session, 2000)?.status).toBe('running');
    f.hook('Stop', 3000);
    expect(f.goals.view(session, 4000)).toMatchObject({status: 'unknown', runtime: 'waiting', activeSeconds: 3});
    expect(f.goals.settle(f.request(4000).ticket, {...answer('continue'), status: 'completed', estimate: null}, 5000)).toBe(true);
    expect(f.goals.view(session, 6000)?.status).toBe('completed');
  });

  it('refuses malformed inference and keeps ambiguous goal relation unknown', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    expect(f.goals.settle(f.request(1000).ticket, {...answer(), identity: session}, 1000)).toBe(false);
    expect(f.goals.settle(f.request(2000).ticket, {relation: 'unknown', status: 'unknown', summary: null, estimate: null}, 2000)).toBe(true);
    expect(f.goals.view(session, 3000)).toMatchObject({status: 'unknown', prediction: null});
  });

  it('ignores non-current turn hooks and clears old tickets at session end', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    const request = f.request(1000);
    f.hook('Interrupt', 2000, 'older', false);
    expect(f.goals.settle(request.ticket, answer(), 3000)).toBe(true);
    const ended = f.request(4000);
    f.goals.end(session);
    expect(f.goals.view(session, 5000)).toBeNull();
    expect(f.goals.settle(ended.ticket, answer(), 5000)).toBe(false);
  });

  it('does not accept forged tickets, cross-conversation results or a regressing clock', () => {
    const f = fixture(); const first = f.hook('UserPromptSubmit', 1000);
    const request = f.request(2000);
    const second = f.hook('UserPromptSubmit', 3000, 'one', true, 'other');
    expect(f.goals.settle({...request.ticket}, answer(), 4000)).toBe(false);
    expect(f.goals.view(second, 4000)?.prediction).toBeNull();
    expect(f.goals.view(first, 500)).toBeNull();
    expect(f.goals.settle(request.ticket, answer(), 5000)).toBe(true);
    f.goals.clear();
    expect(f.goals.view(first, 6000)).toBeNull();
  });
});
