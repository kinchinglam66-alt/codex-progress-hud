import {expect, it} from "vitest";
import {normalizeHookInput} from "../../src/hooks/schema.js";
import {PassiveContextStore} from "../../src/server/passive-context-store.js";
import {PassiveGoals} from "../../src/server/passive-goals.js";
import {createConversationSource} from "../../src/observer/conversation-source.js";
import type {HistoryRecord, HistorySnapshot} from "../../src/observer/history-snapshot.js";
import type {ReadBatch} from "../../src/observer/conversation-record.js";
import {ObserverScheduler, type ObserverObservation, type ObserverWorker} from "../../src/estimation/observer-scheduler.js";
import type {ObserverInput} from "../../src/estimation/observer-contract.js";
import type {PreparedContext} from "../../src/estimation/prepared-context.js";
import type {ResidualRuntime} from '../../src/estimation/residual/runtime.js';
import {createResidualRuntime} from '../../src/estimation/residual/runtime.js';
import {readResidualSegments} from '../../src/estimation/residual/recorder.js';
import {buildDataset} from '../../src/evaluation/residual/dataset.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const token = "protected-full-context-scheduler-test-token-123456789";
const answer = {relation: "replace" as const, status: "running" as const, summary: "task", estimate: {remainingSeconds: 100, errorPercent: 20}};

function history(records: ReadBatch["records"], closed: {value: number}): HistorySnapshot {
  return {
    identity: "verified-history",
    sourceEpoch: 1,
    revision: 1,
    coverage: {complete: true, gaps: []},
    async *records(_signal: AbortSignal): AsyncIterable<HistoryRecord> {
      for (const [ordinal, record] of records.entries()) yield {ordinal, record};
    },
    async close(): Promise<void> { closed.value++; }
  };
}

function fixture(options: {deferHistory?: boolean; deferPreparation?: boolean;research?:ResidualRuntime} = {}) {
  let now = 0;
  let resolveHistory!: (value: HistorySnapshot) => void;
  let resolvePreparation!: (value: PreparedContext) => void;
  let rejectPreparation!: (error: Error) => void;
  const closed = {value: 0};
  let disabled = false;
  let observed = 0;
  let prepared = 0;
  let observedAt: number | undefined;
  const observations: ObserverObservation[] = [];
  let records: ReadBatch["records"] = [{id: "user", turnId: "first", atMs: 1, kind: "user", text: "work"}];
  let resetNext = false;
  let sourceTurnKey = "";
  const source = createConversationSource({
    source: {
      read: async () => { const reset = resetNext; resetNext = false; return {records, caughtUp: true, partialLine: false, reset}; },
      snapshot: async () => {
        if (options.deferHistory) return new Promise<HistorySnapshot>(resolve => { resolveHistory = resolve; });
        return history(records, closed);
      },
      remove: () => {},
      close: async () => {}
    },
    now: () => now,
    wallNow: () => now,
    turnKeyFor: () => sourceTurnKey
  });
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts, source.goals,options.research?event=>options.research!.boundary(event):undefined);
  let prepareResult: PreparedContext = {
    input: {goalSummary: null, activeSeconds: 0, runtime: "running", messages: [{kind: "user", text: "prepared", truncated: false}], truncated: false},
    representation: {mode: "full", sourceComplete: true, originalRecords: 1, compressedThroughOrdinal: null, sizing: "conservative"},
    metrics: {sizing: "conservative", originalTextBytes: 11, originalTextTokenEstimate: 3, preparedRequestBytes: 321,
      preparedTokenEstimate: 87, compressionCalls: 0, cachedCompressionCalls: 0}
  };
  const worker: ObserverWorker = {
    prepareContext: async (input, _snapshot, _signal, _key, _generation, timestamp) => {
      prepared++;
      if(options.research)for await(const record of _snapshot.snapshot.records(_signal))void record;
      observedAt = timestamp;
      if (options.deferPreparation) return new Promise<PreparedContext>((resolve, reject) => {
        resolvePreparation = resolve;
        rejectPreparation = reject;
      });
      return {...prepareResult, input};
    },
    observe: async (_input: ObserverInput) => {
      observed++;
      return {status: "interpreted", interpretation: answer, usage: null};
    },
    status: () => ({active: false, disabled, poisoned: false}),
    disable: () => { disabled = true; },
    close: async () => { disabled = true; }
  };
  const scheduler = new ObserverScheduler({contexts, goals, workers: [worker], now: () => now,
    onObservation: record => observations.push(record),...(options.research?{research:options.research}:{})});
  const envelope = normalizeHookInput("UserPromptSubmit", {session_id: "session", turn_id: "first"}, now, token).envelope;
  goals.observe(envelope, true, now);
  sourceTurnKey = envelope.turnKey!;
  source.attach(envelope.sessionKey, "conversation-id", sourceTurnKey);
  now = 500;
  source.tick();
  const flush = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  };
  const start = async () => {
    await flush();
    scheduler.changed(envelope.sessionKey, "prompt");
    now = 16_000;
    scheduler.tick();
    await flush();
  };
  return {
    scheduler, source, goals, worker, envelope, observations, closed,
    time: (value: number) => { now = value; },
    setRecords: (value: ReadBatch["records"]) => { records = value; },
    resetSource: () => { resetNext = true; },
    setSourceTurn: (value: string) => { sourceTurnKey = value; },
    resolveHistory: (value = history(records, closed)) => resolveHistory(value),
    resolvePreparation: (value = prepareResult) => resolvePreparation(value),
    rejectPreparation: (error = Error("context_too_large")) => rejectPreparation(error),
    prepareResult: (value: PreparedContext) => { prepareResult = value; },
    preparedContext: () => prepareResult,
    start, flush, counts: () => ({prepared, observed, observedAt, disabled})
  };
}

it('captures the full-context prefix without changing production ETA when research fails',async()=>{
  let captures=0;
  const research:ResidualRuntime={capture(){captures++;throw Error('recording failure');},accept(){throw Error('recording failure');},unavailable(){},boundary(){},forget(){},async close(){}};
  const ordinary=fixture(),withResearch=fixture({research});
  await ordinary.start();await withResearch.start();
  expect(captures).toBe(1);
  expect(withResearch.counts()).toEqual(ordinary.counts());
  expect(withResearch.goals.view(withResearch.envelope.sessionKey,16000)).toEqual(ordinary.goals.view(ordinary.envelope.sessionKey,16000));
  await ordinary.scheduler.close();await withResearch.scheduler.close();
});

it('joins a real scheduler forecast with independent same-turn source completion',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'residual-scheduler-'));
  const research=await createResidualRuntime(directory),f=fixture({research});
  f.worker.provenance=()=>({input:'i1',prompt:'p1',model:'m1',algorithm:'a1'});
  try{
    await f.flush();
    const bootstrap=f.goals.request(f.envelope.sessionKey,500)!;
    f.goals.settle(bootstrap.ticket,answer,500);
    f.worker.observe=async()=>({status:'interpreted',interpretation:{...answer,relation:'continue'},usage:null});
    await f.start();
    expect(f.counts().prepared).toBe(1);
    f.time(20000);f.setRecords([{id:'end',turnId:'first',atMs:20000,kind:'runtime',runtime:'waiting',outcome:'completed'}]);
    f.source.tick();await f.flush();f.goals.reconcileSource(f.envelope.sessionKey,20000);
    await f.scheduler.close();await research.close();
    const result=buildDataset((await readResidualSegments(directory)).records);
    expect(result.samples,JSON.stringify(result)).toHaveLength(1);
    expect(result.samples[0]).toMatchObject({actualSeconds:4,features:{rawSeconds:100}});
  }finally{await f.scheduler.close();await research.close();await rm(directory,{recursive:true,force:true});}
});
it('keeps accepted forecasts with a later history watermark in the coverage denominator',async()=>{
  let captured=0,unavailable=0;
  const research:ResidualRuntime={capture(){captured++;return {};},accept(){return true;},unavailable(){unavailable++;},boundary(){},forget(){},async close(){}};
  const f=fixture({research,deferHistory:true});f.worker.provenance=()=>({input:'i',prompt:'p',model:'m',algorithm:'a'});
  await f.start();
  f.resolveHistory(history([{id:'user',turnId:'first',atMs:1,kind:'user',text:'work'},
    {id:'late',turnId:'first',atMs:17000,kind:'tool_result',actionId:'late',exitCode:0}],{value:0}));
  await f.flush();
  expect(f.counts().observed).toBe(1);expect(captured).toBe(0);expect(unavailable).toBe(1);
  await f.scheduler.close();
});

it("does not observe until delayed source history preparation finishes", async () => {
  const f = fixture({deferHistory: true});
  await f.start();
  expect(f.counts()).toMatchObject({prepared: 0, observed: 0});
  f.resolveHistory();
  await f.flush();
  expect(f.counts()).toMatchObject({prepared: 1, observed: 1, observedAt: 16_000});
  expect(f.observations.map(row => row.contextState)).toEqual(expect.arrayContaining(["history_loading", "context_preparing", "context_full"]));
  expect(f.observations.filter(row => row.contextMetrics)).toEqual(expect.arrayContaining([
    expect.objectContaining({kind: "stage", contextMetrics: f.preparedContext().metrics})
  ]));
  expect(f.observations.at(-1)).toMatchObject({contextMetrics: f.preparedContext().metrics});
  expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe("context_full");
  await f.scheduler.close();
});

it("accepts delayed history after same-turn activity advances the trusted clock", async () => {
  const f = fixture({deferHistory: true});
  await f.start();
  const activity = normalizeHookInput("PostToolUse", {session_id: "session", turn_id: "first"}, 17_000, token).envelope;
  f.time(17_000);
  f.goals.observe(activity, true, 17_000);
  f.resolveHistory();
  await f.flush();
  expect(f.counts()).toMatchObject({prepared: 1, observed: 1});
  await f.scheduler.close();
});

it("rejects preparation after a new authenticated turn without observing it", async () => {
  const f = fixture({deferHistory: true});
  await f.start();
  const next = normalizeHookInput("UserPromptSubmit", {session_id: "session", turn_id: "second"}, 16_000, token).envelope;
  f.goals.observe(next, true, 16_000);
  f.setSourceTurn(next.turnKey!);
  f.source.attach(next.sessionKey, "conversation-id", next.turnKey!);
  f.resolveHistory();
  await f.flush();
  expect(f.counts().observed).toBe(0);
  await f.scheduler.close();
});

it("does not persist a stale preparation failure onto the next goal", async () => {
  const f = fixture({deferPreparation: true});
  await f.start();
  const next = normalizeHookInput("UserPromptSubmit", {session_id: "session", turn_id: "second"}, 16_000, token).envelope;
  f.goals.observe(next, true, 16_000);
  f.setSourceTurn(next.turnKey!);
  f.source.attach(next.sessionKey, "conversation-id", next.turnKey!);
  f.rejectPreparation(Error("context_too_large"));
  await f.flush();
  expect(f.scheduler.diagnostics(next.sessionKey).contextState).toBeUndefined();
  await f.scheduler.close();
});

it("rejects preparation after a source epoch reset", async () => {
  const f = fixture({deferHistory: true});
  await f.start();
  f.setRecords([{id: "user", turnId: "first", atMs: 1, kind: "user", text: "reset"}]);
  f.resetSource();
  f.source.changed(f.envelope.sessionKey);
  f.time(16_500);
  f.source.tick();
  await f.flush();
  f.scheduler.tick();
  f.resolveHistory();
  await f.flush();
  expect(f.counts().observed).toBe(0);
  await f.scheduler.close();
});

it("does not observe after the worker is disabled during preparation", async () => {
  const f = fixture({deferPreparation: true});
  await f.start();
  expect(f.counts().prepared).toBe(1);
  f.worker.disable();
  f.resolvePreparation();
  await f.flush();
  expect(f.counts().observed).toBe(0);
  await f.scheduler.close();
});

it("releases a ticket after preparation failure without exposing the raw error", async () => {
  const f = fixture({deferPreparation: true});
  await f.start();
  f.rejectPreparation(Error("context_too_large: secret source text"));
  await f.flush();
  expect(f.counts().observed).toBe(0);
  expect(f.observations.at(-1)).toMatchObject({kind: "result", contextState: "context_too_large"});
  expect(f.observations.at(-1)).not.toHaveProperty("error");
  expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe("context_too_large");
  await f.scheduler.close();
});

it("clears the persisted context state when a new goal begins", async () => {
  const f = fixture({deferPreparation: true});
  await f.start();
  f.rejectPreparation(Error("context_too_large"));
  await f.flush();
  expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe("context_too_large");

  const next = normalizeHookInput("UserPromptSubmit", {session_id: "session", turn_id: "second"}, 16_000, token).envelope;
  f.goals.observe(next, true, 16_000);
  f.setSourceTurn(next.turnKey!);
  f.source.attach(next.sessionKey, "conversation-id", next.turnKey!);
  f.scheduler.changed(next.sessionKey, "prompt");
  expect(f.scheduler.diagnostics(next.sessionKey).contextState).toBeUndefined();
  await f.scheduler.close();
});

it("keeps history preparation independent for two conversations", async () => {
  let now = 0;
  const closed = {value: 0};
  const pending = new Map<string, (snapshot: HistorySnapshot) => void>();
  const turnKeys = new Map<string, string>();
  const source = createConversationSource({
    source: {
      read: async (id) => ({records: [{id: `user-${id}`, turnId: "first", atMs: 1, kind: "user", text: id}], caughtUp: true, partialLine: false, reset: false}),
      snapshot: async (id) => new Promise<HistorySnapshot>(resolve => { pending.set(id, resolve); }),
      remove: () => {},
      close: async () => {}
    },
    now: () => now,
    wallNow: () => now,
    turnKeyFor: host => turnKeys.get(host)!
  });
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts, source.goals);
  const observed: string[] = [];
  const worker = (index: number): ObserverWorker => ({
    prepareContext: async input => ({input, representation: {
      mode: "full", sourceComplete: true, originalRecords: 1, compressedThroughOrdinal: null, sizing: "conservative"
    }}),
    observe: async (_input, _signal, key) => { observed.push(`${index}:${key}`); return {status: "interpreted", interpretation: answer, usage: null}; },
    status: () => ({active: false, disabled: false, poisoned: false}),
    disable: () => {}, close: async () => {}
  });
  const scheduler = new ObserverScheduler({contexts, goals, workers: [worker(1), worker(2)], now: () => now});
  const envelopes = ["a", "b"].map(session => normalizeHookInput("UserPromptSubmit", {session_id: session, turn_id: "first"}, 0, token).envelope);
  for (const envelope of envelopes) {
    goals.observe(envelope, true, 0);
    const host = `host-${envelope.sessionKey}`;
    turnKeys.set(host, envelope.turnKey!);
    source.attach(envelope.sessionKey, host, envelope.turnKey!);
  }
  now = 500;
  source.tick();
  await new Promise<void>(resolve => setImmediate(resolve));
  scheduler.changed(envelopes[0]!.sessionKey, "prompt");
  scheduler.changed(envelopes[1]!.sessionKey, "prompt");
  now = 16_000;
  scheduler.tick();
  await Promise.resolve();
  expect(pending.size).toBe(2);
  pending.get(`host-${envelopes[0]!.sessionKey}`)!(history([], closed));
  await new Promise<void>(resolve => setImmediate(resolve));
  await Promise.resolve(); await Promise.resolve();
  expect(observed).toHaveLength(1);
  pending.get(`host-${envelopes[1]!.sessionKey}`)!(history([], closed));
  await new Promise<void>(resolve => setImmediate(resolve));
  await Promise.resolve(); await Promise.resolve();
  expect(observed).toHaveLength(2);
  await scheduler.close();
  await source.close();
});
