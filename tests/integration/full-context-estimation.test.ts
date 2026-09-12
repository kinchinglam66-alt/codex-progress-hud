import {appendFile, mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it} from "vitest";
import {normalizeHookInput} from "../../src/hooks/schema.js";
import {createLocalSessionReader} from "../../src/observer/local-session-reader.js";
import {createConversationSource} from "../../src/observer/conversation-source.js";
import {PassiveContextStore} from "../../src/server/passive-context-store.js";
import {PassiveGoals} from "../../src/server/passive-goals.js";
import {ObserverScheduler, type ObserverObservation, type ObserverWorker} from "../../src/estimation/observer-scheduler.js";
import type {ObserverInput} from "../../src/estimation/observer-contract.js";
import {withContextPreparation} from "../../src/estimation/context-worker.js";
import {packObserverInput} from "../../src/estimation/observer-input.js";
import type {PreparedContext} from "../../src/estimation/prepared-context.js";

const TOKEN = "protected-task6-fixture-token-123456789";
const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
const answer = {relation: "replace" as const, status: "running" as const, summary: "synthetic wait", estimate: {remainingSeconds: 90, errorPercent: 20}};

function line(type: string, payload: unknown, atMs = 1_700_000_000_000): string {
  return `${JSON.stringify({timestamp: new Date(atMs).toISOString(), type, payload})}\n`;
}
function meta(thread: string): string { return line("session_meta", {id: thread}); }
function message(role: "user" | "assistant", turnId: string, id: string, text: string): string {
  return line("response_item", {type: "message", id, role, turn_id: turnId,
    content: [{type: role === "user" ? "input_text" : "output_text", text}]});
}
function taskStarted(turnId: string, atMs = 1_700_000_000_100): string {
  return line("event_msg", {type: "task_started", turn_id: turnId, id: `start-${turnId}`}, atMs);
}
function taskComplete(turnId: string, atMs = 1_700_000_006_000): string {
  return line("event_msg", {type: "task_complete", turn_id: turnId, id: `complete-${turnId}`}, atMs);
}
function toolStart(turnId: string, actionId: string, text: string, atMs = 1_700_000_000_300): string {
  return line("response_item", {type: "custom_tool_call", id: `start-${actionId}`, call_id: actionId,
    name: "synthetic_tool", input: text, turn_id: turnId}, atMs);
}
function toolResult(turnId: string, actionId: string, text: string, atMs = 1_700_000_000_400): string {
  return line("response_item", {type: "custom_tool_call_output", id: `result-${actionId}`, call_id: actionId,
    output: text, turn_id: turnId}, atMs);
}
async function createFile(root: string, thread: string, contents: string): Promise<string> {
  const directory = join(root, "2026", "09", "12");
  await mkdir(directory, {recursive: true});
  const file = join(directory, `rollout-2026-09-12T00-00-00-${thread}.jsonl`);
  await writeFile(file, contents, {encoding: "utf8", mode: 0o600});
  return file;
}
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "full-context-estimation-"));
  roots.push(root);
  return root;
}
function signal(): AbortSignal { return new AbortController().signal; }
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setTimeout(resolve, 1));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}
function config(compressor: {summarize(request: {text: string; firstOrdinal: number; lastOrdinal: number}, signal: AbortSignal): Promise<{text: string; firstOrdinal: number; lastOrdinal: number}>}) {
  return {
    capacity: {contextTokens: 100_000, outputReserveTokens: 2_000, requestBytes: 500_000, source: "configured" as const},
    sizer: {kind: "conservative" as const, count: (text: string) => Buffer.byteLength(text, "utf8")},
    serialize: packObserverInput,
    serializeCompression: JSON.stringify,
    compressor
  };
}

interface Harness {
  root: string;
  file: string;
  thread: string;
  currentTurn: string;
  envelope: ReturnType<typeof normalizeHookInput>["envelope"];
  source: ReturnType<typeof createConversationSource>;
  goals: PassiveGoals;
  scheduler: ObserverScheduler;
  inputs: ObserverInput[];
  observations: ObserverObservation[];
  now(value: number): void;
  sourceTurn(turnId: string, turnKey: string): void;
  refresh(): Promise<void>;
  start(): Promise<void>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

async function harness(options: {
  thread?: string;
  currentTurn?: string;
  contents: string;
  capacity?: ReturnType<typeof config>["capacity"];
  compressor?: {summarize(request: {text: string; firstOrdinal: number; lastOrdinal: number}, signal: AbortSignal): Promise<{text: string; firstOrdinal: number; lastOrdinal: number}>};
  configure?: (scope: {conversationKey: string; turnGeneration: number; sourceEpoch: number; signal: AbortSignal}) => Promise<ReturnType<typeof config>>;
}): Promise<Harness> {
  let clock = 0;
  const root = await makeRoot();
  const thread = options.thread ?? THREAD_A;
  const currentTurn = options.currentTurn ?? "current";
  const file = await createFile(root, thread, options.contents);
  const reader = createLocalSessionReader({root});
  const turnKeys = new Map<string, string>();
  const envelope = normalizeHookInput("UserPromptSubmit", {session_id: `session-${thread.slice(0, 4)}`, turn_id: currentTurn}, 0, TOKEN).envelope;
  turnKeys.set(`${thread}:${currentTurn}`, envelope.turnKey!);
  const source = createConversationSource({source: reader, now: () => clock, wallNow: () => clock,
    turnKeyFor: (host, turn) => turnKeys.get(`${host}:${turn}`) ?? `${host}:${turn}`});
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts, source.goals);
  const inputs: ObserverInput[] = [];
  const observations: ObserverObservation[] = [];
  let disabled = false;
  const delegate: ObserverWorker = {
    observe: async input => { inputs.push(input); return {status: "interpreted", interpretation: answer, usage: null}; },
    status: () => ({active: false, disabled, poisoned: false}),
    disable: () => { disabled = true; },
    close: async () => { disabled = true; }
  };
  const compressor = options.compressor ?? {summarize: async request => ({...request, text: "synthetic older-history summary"})};
  const worker = withContextPreparation(delegate, options.configure ?? (async () => ({...config(compressor), ...(options.capacity === undefined ? {} : {capacity: options.capacity})})));
  const scheduler = new ObserverScheduler({contexts, goals, workers: [worker], now: () => clock,
    onObservation: record => observations.push(record)});
  goals.observe(envelope, true, 0);
  source.attach(envelope.sessionKey, thread, envelope.turnKey!);
  source.setActive(envelope.sessionKey, true);
  const refresh = async () => {
    const previousRevision=source.snapshot(envelope.sessionKey)?.revision??0;
    source.changed(envelope.sessionKey);
    clock = Math.max(clock, 1_000);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      source.tick();
      await flush();
      const current=source.snapshot(envelope.sessionKey);
      if (current?.health === "ready" && current.revision > previousRevision) return;
      if (goals.contextHealth(envelope.sessionKey) === "error") {
        const error = await reader.read(thread, signal()).catch(caught => caught);
        throw Error(`synthetic source fixture read failed: ${String(error)}`);
      }
    }
    throw Error("synthetic source fixture did not become ready");
  };
  const start = async () => {
    clock = 500;
    await refresh();
    scheduler.changed(envelope.sessionKey, "prompt");
    clock = 16_000;
    scheduler.tick();
    await flush();
  };
  const waitForIdle = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (scheduler.stats().inFlight === 0) return;
      await flush();
    }
    throw Error("synthetic scheduler fixture did not become idle");
  };
  return {root, file, thread, currentTurn, envelope, source, goals, scheduler, inputs, observations,
    now: value => { clock = value; }, sourceTurn: (turnId, turnKey) => { turnKeys.set(`${thread}:${turnId}`, turnKey); },
    refresh, start, waitForIdle, close: async () => { await scheduler.close(); await source.close(); }};
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, {recursive: true, force: true});
});

it("prepares complete local history, scopes ETA to the current turn, and re-observes appended current context", async () => {
  const f = await harness({contents: meta(THREAD_A) + message("user", "old", "old-user", "OLD-USER-SENTINEL") +
    message("assistant", "old", "old-assistant", "OLD-ASSISTANT-SENTINEL") + toolStart("old", "old-action", "OLD-TOOL-SENTINEL") +
    toolResult("old", "old-action", "OLD-TOOL-RESULT") + taskStarted("current") +
    message("user", "current", "current-user", "CURRENT-REQUIREMENT") + toolStart("current", "current-action", "CURRENT-ACTION")});
  await f.start();
  await f.waitForIdle();
  expect(f.inputs).toHaveLength(1);
  expect(f.observations.at(-1)).toMatchObject({kind: "result", contextState: "context_full"});
  expect(f.inputs[0]?.representation).toMatchObject({mode: "full", sourceComplete: true});
  expect(f.inputs[0]?.messages.find(message => message.text === "OLD-USER-SENTINEL")).toMatchObject({scope: "background"});
  expect(f.inputs[0]?.messages.find(message => message.text === "CURRENT-REQUIREMENT")).toMatchObject({scope: "current"});
  expect(f.inputs[0]?.observation?.currentAction).toMatchObject({text: "CURRENT-ACTION"});

  await appendFile(f.file, toolResult("current", "current-action", "CURRENT-LATER-RESULT", 1_700_000_001_000) +
    message("assistant", "current", "later-assistant", "CURRENT-LATER-ASSISTANT"));
  f.now(17_000);
  await f.refresh();
  f.now(1_000_000);
  f.scheduler.changed(f.envelope.sessionKey, "prompt");
  f.now(1_010_011);
  f.scheduler.tick();
  await flush();
  await f.waitForIdle();
  expect(f.inputs).toHaveLength(2);
  expect(f.inputs[1]?.messages.some(message => message.text === "CURRENT-LATER-ASSISTANT")).toBe(true);
  expect(f.inputs[1]?.observation?.currentAction).toBeNull();
  expect(f.inputs[1]?.messages.filter(message => message.scope === "current").every(message => message.text.includes("CURRENT"))).toBe(true);
  await f.close();
});

it("keeps unsupported payload coverage incomplete after the local source is fully read", async () => {
  const unsupported = line("response_item", {type: "message", id: "image", role: "user", turn_id: "current",
    content: [{type: "input_image", path: "synthetic-not-read.txt"}]});
  const f = await harness({contents: meta(THREAD_A) + unsupported + taskStarted("current") +
    message("user", "current", "requirement", "CURRENT-INCOMPLETE")});
  await f.start();
  await f.waitForIdle();
  expect(f.inputs).toHaveLength(1);
  expect(f.inputs[0]?.representation).toMatchObject({mode: "incomplete", sourceComplete: false});
  expect(f.inputs[0]?.observation?.historyComplete).toBe(false);
  expect(f.observations.at(-1)).toMatchObject({kind: "result", contextState: "history_incomplete"});
  await f.close();
});

it("rejects a prepared request after verified source replacement", async () => {
  let begin!: () => void;
  let release!: () => void;
  const began = new Promise<void>(resolve => { begin = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await harness({contents: meta(THREAD_A) + taskStarted("current") + message("user", "current", "before", "BEFORE-REPLACEMENT"),
    configure: async scope => { begin(); await gate; return config({summarize: async request => ({...request, text: "summary"})}); }});
  const started = f.start();
  await began;
  await writeFile(f.file, meta(THREAD_A) + taskStarted("current") + message("user", "current", "after", "AFTER-REPLACEMENT"), {encoding: "utf8"});
  f.now(17_000);
  await f.refresh();
  release();
  await started;
  await flush();
  expect(f.inputs).toHaveLength(0);
  expect(f.observations.at(-1)).not.toHaveProperty("error");
  await f.close();
});

it("holds active time at the persisted wait/end boundary", async () => {
  const f = await harness({contents: meta(THREAD_A) + taskStarted("current", 1_000) +
    message("user", "current", "wait-task", "WAIT-END-TASK") + taskComplete("current", 6_000)});
  f.now(8_000);
  await f.refresh();
  f.goals.reconcileSource(f.envelope.sessionKey, 8_000);
  expect(f.goals.view(f.envelope.sessionKey, 8_000)).toMatchObject({runtime: "waiting", activeSeconds: 6});
  expect(f.goals.view(f.envelope.sessionKey, 3_600_000)).toMatchObject({runtime: "waiting", activeSeconds: 6});
  await f.close();
});

it("compresses two paged conversations independently and cancels without cross-leaking history", async () => {
  const root = await makeRoot();
  const oldCount = 150;
  const makeHistory = (thread: string, marker: string) => meta(thread) +
    Array.from({length: oldCount}, (_, index) => message("assistant", "old", `old-${marker}-${index}`, `${marker}-OLD-${index}-` + "x".repeat(30 * 1024))).join("") + taskStarted("current") +
    message("user", "current", `current-${marker}`, `${marker}-CURRENT-REQUIREMENT`) +
    toolStart("current", `action-${marker}`, `${marker}-CURRENT-ACTION`) + toolResult("current", `action-${marker}`, `${marker}-CURRENT-RESULT`);
  const fileA = await createFile(root, THREAD_A, makeHistory(THREAD_A, "A"));
  const fileB = await createFile(root, THREAD_B, makeHistory(THREAD_B, "B"));
  const reader = createLocalSessionReader({root});
  const turnKeys = new Map<string, string>();
  const source = createConversationSource({source: reader, now: () => clock, wallNow: () => clock,
    turnKeyFor: (host, turn) => turnKeys.get(`${host}:${turn}`) ?? `${host}:${turn}`});
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts, source.goals);
  let clock = 0;
  const inputs = new Map<string, ObserverInput>();
  const summaries = new Map<string, Array<{text: string; firstOrdinal: number; lastOrdinal: number}>>();
  const workers: ObserverWorker[] = [];
  const envelopes = [THREAD_A, THREAD_B].map((thread, index) => {
    const envelope = normalizeHookInput("UserPromptSubmit", {session_id: `stress-${index}`, turn_id: "current"}, 0, TOKEN).envelope;
    turnKeys.set(`${thread}:current`, envelope.turnKey!);
    goals.observe(envelope, true, 0);
    source.attach(envelope.sessionKey, thread, envelope.turnKey!);
    const delegate: ObserverWorker = {observe: async input => {
      inputs.set(envelope.sessionKey, input); return {status: "interpreted", interpretation: answer, usage: null};
    }, status: () => ({active: false, disabled: false, poisoned: false}), disable: () => {}, close: async () => {}};
    const compressor = {summarize: async (request: {text: string; firstOrdinal: number; lastOrdinal: number}) => {
      const list = summaries.get(envelope.sessionKey) ?? []; list.push({...request}); summaries.set(envelope.sessionKey, list);
      return {...request, text: `${envelope.sessionKey}-synthetic-summary`};
    }};
    workers.push(withContextPreparation(delegate, async () => ({...config(compressor), capacity: {
      contextTokens: 200_000, outputReserveTokens: 2_000, requestBytes: 300_000, source: "configured" as const
    }, cacheScope: envelope.sessionKey})));
    return envelope;
  });
  const scheduler = new ObserverScheduler({contexts, goals, workers, now: () => clock});
  clock = 500;
  source.changed(envelopes[0]!.sessionKey); source.changed(envelopes[1]!.sessionKey);
  source.tick(); await flush();
  for (let attempt = 0; attempt < 100 &&
      (source.goals.health!(envelopes[0]!.sessionKey) !== "ready" || source.goals.health!(envelopes[1]!.sessionKey) !== "ready"); attempt += 1) {
    source.tick();
    await flush();
  }
  scheduler.changed(envelopes[0]!.sessionKey, "prompt"); scheduler.changed(envelopes[1]!.sessionKey, "prompt");
  clock = 16_000; scheduler.tick();
  for (let attempt = 0; attempt < 300 && scheduler.stats().inFlight > 0; attempt += 1) await flush();
  expect(inputs).toHaveLength(2);
  for (const [index, envelope] of envelopes.entries()) {
    const marker = index === 0 ? "A" : "B";
    const input = inputs.get(envelope.sessionKey)!;
    expect(input.representation).toMatchObject({mode: "compressed", sourceComplete: true});
    expect(input.representation!.originalRecords).toBeGreaterThan(128);
    expect(input.historySummary?.text).toContain(envelope.sessionKey);
    expect(input.messages.some(message => message.text.includes(`${marker}-CURRENT-REQUIREMENT`))).toBe(true);
    expect(input.messages.some(message => message.text.includes(index === 0 ? "B-OLD-" : "A-OLD-"))).toBe(false);
    expect(input.observation?.currentAction).toBeNull();
    expect(input.representation!.compressedThroughOrdinal).not.toBeNull();
    const represented = new Set(input.messages.map(message => message.event?.ordinal));
    for (const request of summaries.get(envelope.sessionKey) ?? []) {
      const parsed = JSON.parse(request.text) as {records?: Array<{ordinal: number}>};
      for (const record of parsed.records ?? []) represented.add(record.ordinal);
    }
    expect(represented.size).toBeGreaterThan(128);
    expect(input.messages.some(message => message.text.includes(`${marker}-CURRENT-RESULT`))).toBe(true);
  }
  const snapshot = await reader.snapshot(THREAD_A, signal());
  try {
    for await (const _entry of snapshot.records(signal())) { /* reveal final coverage */ }
    expect(snapshot.coverage.complete).toBe(true);
  } finally { await snapshot.close(); }
  await scheduler.close();
  await source.close();
  void fileA; void fileB;
});

it("cancels a paged compression pass without invoking the fake provider", async () => {
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const compressor = {summarize: async (request: {text: string; firstOrdinal: number; lastOrdinal: number}, abortSignal: AbortSignal) => {
    begin();
    await new Promise<void>(resolve => abortSignal.addEventListener("abort", () => resolve(), {once: true}));
    abortSignal.throwIfAborted();
    return {...request, text: "unreachable synthetic summary"};
  }};
  const contents = meta(THREAD_A) + Array.from({length: 140}, (_, index) =>
    message("assistant", "old", `cancel-${index}`, `CANCEL-OLD-${index}-` + "x".repeat(8 * 1024))).join("") +
    taskStarted("current") + message("user", "current", "cancel-current", "CANCEL-CURRENT");
  const f = await harness({contents, capacity: {
    contextTokens: 20_000, outputReserveTokens: 2_000, requestBytes: 80_000, source: "configured"
  }, compressor});
  const running = f.start();
  await started;
  await f.scheduler.close();
  await running;
  expect(f.inputs).toHaveLength(0);
  await f.close();
});
