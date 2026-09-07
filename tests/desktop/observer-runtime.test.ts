import {expect, afterEach, describe, it, vi} from 'vitest';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
import type {ObserverWorker} from '../../src/estimation/observer-scheduler.js';
import type {ObserverAttestation} from '../../src/estimation/observer-consent.js';
import type {ReleaseAccountingOwner} from '../../src/estimation/release-accounting.js';
import type {SubscriptionAccounting} from '../../src/estimation/subscription-accounting.js';
import type {Invocation} from '../../src/estimation/owned-process.js';
import {createDesktopObserverRuntime} from '../../src/desktop/observer-runtime.js';

const input: ObserverInput = {
  goalSummary: 'Build a report',
  activeSeconds: 20,
  runtime: 'running',
  messages: [{kind: 'user', text: 'Build the report', truncated: false}],
  truncated: false,
};

const interpretation = JSON.stringify({
  relation: 'continue',
  status: 'running',
  summary: 'Building the report',
  estimate: {remainingSeconds: 7200, errorPercent: 40},
});

const observerOutput = [
  JSON.stringify({type: 'turn.started'}),
  JSON.stringify({type: 'item.completed', item: {id: 'item_1', type: 'agent_message', text: interpretation}}),
  JSON.stringify({type: 'turn.completed', usage: {input_tokens: 20, output_tokens: 3, cached_input_tokens: 5}}),
].join('\n') + '\n';

interface RuntimeIdentity {
  inspect(signal: AbortSignal): Promise<{accountLabel: string; evidence: ObserverAttestation}>;
  prepareEstimate(input: ObserverInput, signal: AbortSignal): Promise<{accountLabel: string; evidence: ObserverAttestation; invocation: Invocation}>;
  disable(): void;
  close(): Promise<void>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {resolve = nextResolve; reject = nextReject;});
  return {promise, resolve, reject};
}

function invocation(): Invocation {
  return {
    executable: process.execPath,
    cwd: process.cwd(),
    args: ['-e', `process.stdout.write(${JSON.stringify(observerOutput)})`],
    env: process.env,
    input: '',
  };
}

function owner(events: string[]): ReleaseAccountingOwner {
  let next = 0;
  let closed = false;
  const views = new Set<SubscriptionAccounting>();
  return {
    forConversation(key: string): SubscriptionAccounting {
      const view: SubscriptionAccounting = {
        reserve: async () => {
          if (closed) return null;
          events.push(`reserve:${key}`);
          return `reservation-${next++}`;
        },
        settle: async (_id, usage) => {events.push(`settle:${key}:${usage ? 'known' : 'unknown'}`);},
        cancelBeforeDispatch:async()=>{events.push(`not-dispatched:${key}`);},
        close: async () => {events.push(`view-close:${key}`); views.delete(view);},
      };
      views.add(view);
      return view;
    },
    snapshot: () => ({starts: next, activeStarts: next, inFlight: 0, unresolved: 0, knownTokens: 0, unknown: 0, poisoned: false}),
    close: async () => {closed = true; events.push('accounting-close');},
  };
}

function evidence(now: number, accountFingerprint = 'a'.repeat(64)): ObserverAttestation {
  return {
    accountFingerprint,
    routeFingerprint: 'b'.repeat(64),
    assetsFingerprint: 'c'.repeat(64),
    observedAt: now,
    expiresAt: now + 300000,
  };
}

function identityFor(clock: () => number, events: string[], options: {
  inspect?: () => ObserverAttestation;
  prepare?: () => Promise<void> | void;
  closeError?: Error;
  invocation?: () => Invocation;
} = {}): RuntimeIdentity {
  return {
    inspect: async signal => {
      if (signal.aborted) throw new Error('ABORTED');
      events.push('inspect');
      return {accountLabel: 'synthetic@example.invalid', evidence: options.inspect?.() ?? evidence(clock())};
    },
    prepareEstimate: async (_input, signal) => {
      if (signal.aborted) throw new Error('ABORTED');
      events.push('prepare');
      await options.prepare?.();
      return {accountLabel: 'synthetic@example.invalid', evidence: options.inspect?.() ?? evidence(clock()), invocation: options.invocation?.() ?? invocation()};
    },
    disable: () => {events.push('identity-disable');},
    close: async () => {events.push('identity-close'); if (options.closeError) throw options.closeError;},
  };
}

function dialogFor(events: string[], response = 0) {
  return {showMessageBox: async () => {events.push('dialog'); return {response};}};
}

describe('desktop observer runtime composition', () => {
  afterEach(() => {vi.useRealTimers();});

  it('keeps both slots unavailable and performs no dispatch before consent and accounting readiness', async () => {
    const events: string[] = [];
    const consent = deferred<{response: number}>();
    const accounting = deferred<ReleaseAccountingOwner>();
    const identity = identityFor(() => 0, events);
    const runtime = createDesktopObserverRuntime({identity, dialog: {showMessageBox: async () => {events.push('dialog'); return consent.promise;}}, openAccounting: () => accounting.promise, now: () => 0});
    const start = runtime.start(new AbortController().signal);
    await vi.waitFor(() => expect(events).toContain('dialog'));
    expect(runtime.workers).toHaveLength(2);
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    await expect(runtime.workers[0]!.observe(input, new AbortController().signal, 'before-ready')).resolves.toMatchObject({status: 'disabled'});
    expect(events).not.toContain('prepare');
    consent.resolve({response: 0});
    await vi.waitFor(() => expect(events).not.toContain('identity-disable'));
    await expect(runtime.workers[0]!.observe(input, new AbortController().signal, 'during-ledger-open')).resolves.toMatchObject({status: 'disabled'});
    expect(events).not.toContain('reserve:during-ledger-open');
    accounting.resolve(owner(events));
    await start;
    expect(runtime.workers.every(worker => !worker.status().disabled)).toBe(true);
    await runtime.close();
    expect(events).toContain('accounting-close');
  });

  it('exposes exactly two reusable accounted observer slots after authorization', async () => {
    const events: string[] = [];
    const accountingOwner = owner(events);
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events),
      dialog: dialogFor(events),
      openAccounting: async () => accountingOwner,
      now: () => 0,
    });
    await runtime.start(new AbortController().signal);
    expect(runtime.workers).toHaveLength(2);
    expect(new Set(runtime.workers).size).toBe(2);
    const results = await Promise.all(runtime.workers.map((worker, index) => worker.observe(input, new AbortController().signal, `conversation-${index}`)));
    expect(results.every(result => result.status === 'interpreted')).toBe(true);
    expect(events.filter(event => event.startsWith('reserve:'))).toHaveLength(2);
    await runtime.close();
  });

  it('revokes a cancelled consent attempt and ignores its late dialog response', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const consent = deferred<{response: number}>();
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events),
      dialog: {showMessageBox: async () => {events.push('dialog'); return consent.promise;}},
      openAccounting: async () => owner(events),
      now: () => 0,
    });
    const start = runtime.start(controller.signal);
    await vi.waitFor(() => expect(events).toContain('dialog'));
    controller.abort();
    await start;
    consent.resolve({response: 0});
    await Promise.resolve();
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    expect(events).not.toContain('accounting-close');
    await runtime.close();
  });

  it('refreshes the same identity binding every 120 seconds beyond the initial five-minute evidence window', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => clock, events),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => clock,
    });
    await runtime.start(new AbortController().signal);
    for (let index = 0; index < 4; index++) {
      clock += 120000;
      await vi.advanceTimersByTimeAsync(120000);
    }
    expect(events.filter(event => event === 'inspect').length).toBeGreaterThanOrEqual(5);
    expect(runtime.workers.every(worker => !worker.status().disabled)).toBe(true);
    await runtime.close();
  });

  it('revokes both slots when a refresh observes an identity change', async () => {
    vi.useFakeTimers();
    let clock = 0;
    let changed = false;
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => clock, events, {inspect: () => evidence(clock, changed ? 'd'.repeat(64) : 'a'.repeat(64))}),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => clock,
    });
    await runtime.start(new AbortController().signal);
    changed = true;
    clock = 120000;
    await vi.advanceTimersByTimeAsync(120000);
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    await expect(runtime.workers[0]!.observe(input, new AbortController().signal, 'changed-account')).resolves.toMatchObject({status: 'disabled'});
    await runtime.close();
  });

  it('fails closed when a delayed renewal lets the original evidence expire', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const original = evidence(0);
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => clock, events, {inspect: () => original}),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => clock,
    });
    await runtime.start(new AbortController().signal);
    clock = 360000;
    await vi.advanceTimersByTimeAsync(360000);
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    expect(events).not.toContain('prepare');
    await runtime.close();
  });

  it('cancels preparation and prevents admission when disabled during metadata work', async () => {
    const events: string[] = [];
    const preparation = deferred<void>();
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events, {prepare: () => preparation.promise}),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => 0,
    });
    await runtime.start(new AbortController().signal);
    const pending = runtime.workers[0]!.observe(input, new AbortController().signal, 'during-preparation');
    await vi.waitFor(() => expect(events).toContain('prepare'));
    runtime.disable();
    preparation.resolve();
    await expect(pending).resolves.toMatchObject({status: 'disabled'});
    expect(events).not.toContain('reserve:during-preparation');
    await runtime.close();
  });

  it('closes workers and drained metadata before closing accounting', async () => {
    const events: string[] = [];
    const preparation = deferred<void>();
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events, {prepare: () => preparation.promise}),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => 0,
    });
    await runtime.start(new AbortController().signal);
    const pending = runtime.workers[0]!.observe(input, new AbortController().signal, 'close-order');
    await vi.waitFor(() => expect(events).toContain('prepare'));
    const closing = runtime.close();
    preparation.resolve();
    await pending;
    await closing;
    expect(events.indexOf('view-close:close-order')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('accounting-close')).toBeGreaterThan(events.indexOf('view-close:close-order'));
  });

  it('closes a ledger that resolves after disable without exposing ready slots', async () => {
    const events: string[] = [];
    const accounting = deferred<ReleaseAccountingOwner>();
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events),
      dialog: dialogFor(events),
      openAccounting: () => {events.push('open-accounting'); return accounting.promise;},
      now: () => 0,
    });
    const start = runtime.start(new AbortController().signal);
    await vi.waitFor(() => expect(events).toContain('dialog'));
    await vi.waitFor(() => expect(events).toContain('open-accounting'));
    runtime.disable();
    await vi.waitFor(() => expect(events).toContain('identity-disable'));
    const lateOwner = owner(events);
    accounting.resolve(lateOwner);
    await start;
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    expect(events).not.toContain('accounting-close');
    await runtime.close();
    expect(events.filter(event => event === 'accounting-close')).toHaveLength(1);
  });

  it('retains accounting when a delegate close is unconfirmed and preserves delegate ownership in status', async () => {
    vi.resetModules();
    vi.doMock('../../src/estimation/observer-worker.js', () => ({
      createAccountedObserverWorker: () => ({
        observe: async () => unavailableResult(),
        status: () => ({active: true, disabled: true, poisoned: true}),
        disable: () => undefined,
        close: async () => {throw new Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED');},
      }),
    }));
    try {
      const {createDesktopObserverRuntime: createMockedRuntime} = await import('../../src/desktop/observer-runtime.js');
      const events: string[] = [];
      const runtime = createMockedRuntime({
        identity: identityFor(() => 0, events),
        dialog: dialogFor(events),
        openAccounting: async () => owner(events),
        now: () => 0,
      });
      await runtime.start(new AbortController().signal);
      expect(runtime.workers[0]!.status()).toMatchObject({active: true, disabled: true, poisoned: true});
      runtime.disable();
      expect(runtime.workers[0]!.status()).toMatchObject({active: true, disabled: true, poisoned: true});
      await expect(runtime.close()).rejects.toThrow('OBSERVER_CLOSE_UNCONFIRMED');
      expect(events).not.toContain('accounting-close');
    } finally {
      vi.doUnmock('../../src/estimation/observer-worker.js');
      vi.resetModules();
    }
  });

  it('retains accounting when identity close is not confirmed', async () => {
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events, {closeError: new Error('IDENTITY_CLOSE_FAILED')}),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => 0,
    });
    await runtime.start(new AbortController().signal);
    await expect(runtime.close()).rejects.toThrow('OBSERVER_CLOSE_UNCONFIRMED');
    expect(events).not.toContain('accounting-close');
  });

  it('does not turn a late accounting close failure into a successful shutdown', async () => {
    const events: string[] = [];
    const accounting = deferred<ReleaseAccountingOwner>();
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events),
      dialog: dialogFor(events),
      openAccounting: () => accounting.promise,
      now: () => 0,
    });
    const start = runtime.start(new AbortController().signal);
    await vi.waitFor(() => expect(events).toContain('dialog'));
    await vi.waitFor(() => expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true));
    runtime.disable();
    const lateOwner = owner(events);
    lateOwner.close = async () => {events.push('accounting-close-failed'); throw new Error('ACCOUNTING_CLOSE_FAILED');};
    accounting.resolve(lateOwner);
    await start;
    await expect(runtime.close()).rejects.toThrow('ACCOUNTING_CLOSE_FAILED');
    expect(events).toContain('identity-close');
    expect(events).toContain('accounting-close-failed');
    expect(events.indexOf('identity-close')).toBeLessThan(events.indexOf('accounting-close-failed'));
  });
});

function unavailableResult() {
  return {status: 'disabled' as const, interpretation: null, usage: null};
}
