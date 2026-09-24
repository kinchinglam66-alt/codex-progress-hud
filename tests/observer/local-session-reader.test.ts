import {appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {pairCompletedToolCapture} from "../../src/estimation/vitest-pace-adapter.js";
import {packObserverInput} from "../../src/estimation/observer-input.js";
import {assembleContext} from "../../src/observer/context-assembler.js";
import {createLocalSessionReader} from "../../src/observer/local-session-reader.js";
import {createPrefixFingerprint} from '../../src/estimation/residual/fingerprint.js';
import {captureHistoryFeatures} from '../../src/estimation/residual/capture.js';
import {executionObservations} from '../../src/observer/execution-observations.js';

const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";
const THREAD_V7 = "01a0766f-e48a-70e0-b8a8-4abb83140175";
const PARENT_THREAD = "33333333-3333-7333-8333-333333333333";
const CHILD_THREAD = "44444444-4444-7444-8444-444444444444";
const cleanups: Array<() => Promise<void>> = [];
it.each([{secs:2,nanos:500000000},{secs:-1,nanos:0},{secs:1,nanos:1000000000}])('retains only valid reported duration without inventing a start: %j',async duration=>{
 const f=await fixture(THREAD_A,meta(THREAD_A)+taskStarted('turn')+line('event_msg',{
  type:'item_completed',turn_id:'turn',item:{type:'CommandExecution',id:'reported',command:['echo','data'],cwd:'/app',duration,aggregated_output:'done'}},1_700_000_004_000));
 const reader=createLocalSessionReader({root:f.root});
 try{
  const batch=await reader.read(THREAD_A,signal());
  const observation=executionObservations(batch.records,'turn',1_700_000_005_000)!;
  expect(observation.samples).toEqual([]);
  if(duration.secs===2)expect(observation.reportedSamples).toEqual([expect.objectContaining({reportedSeconds:2.5,startTimeKnown:false,activeTimeKnown:false})]);
  else expect(observation.reportedSamples).toEqual([]);
 }finally{await reader.close();}
});

it('preserves native argv boundaries and feeds paired operation timing without execution',async()=>{
 const argv=['pwsh.exe','-Command','echo "a b"'];
 const start=line('event_msg',{type:'item_started',turn_id:'turn',item:{type:'CommandExecution',id:'argv',command:argv,cwd:'/app'}},1_700_000_003_000);
 const f=await fixture(THREAD_A,meta(THREAD_A)+taskStarted('turn')+start+commandCompleted('argv','turn'));
 const reader=createLocalSessionReader({root:f.root});
 try{
  const batch=await reader.read(THREAD_A,signal());
  expect(batch.records.find(r=>r.kind==='tool_start')).toMatchObject({commandArgv:argv,text:JSON.stringify(argv)});
  const observations=executionObservations(batch.records,'turn',1_700_000_005_000)!;
  expect(observations.comparableGroups[0]).toMatchObject({count:1,medianSeconds:1,minimumSampleCountMet:false});
 }finally{await reader.close();}
});

it('preserves estimator attribution differences but canonicalizes research fingerprints',async()=>{
  const f=await fixture(THREAD_A,meta(THREAD_A)+taskStarted('turn')+user('work','u','turn')+
    line('response_item',{type:'message',id:'a',role:'assistant',content:[{type:'output_text',text:'working'}]},1_700_000_002_000));
  const reader=createLocalSessionReader({root:f.root});
  try{
    const batch=await reader.read(THREAD_A,signal()),snapshot=await reader.snapshot(THREAD_A,signal());
    const full=[];for await(const entry of snapshot.records(signal()))full.push(entry.record);
    expect(batch.records.find(r=>r.id==='a')?.turnId).toBe('turn');
    expect(full.find(r=>r.id==='a')?.turnId).toBeNull();
    expect(batch.records.find(r=>r.id==='a')?.sourceTurnId).toBeNull();
    expect(full.find(r=>r.id==='a')?.sourceTurnId).toBeNull();
    const legacyHash=createPrefixFingerprint(),fullHash=createPrefixFingerprint();
    batch.records.filter(r=>r.turnId==='turn').forEach(r=>legacyHash.add(r));
    full.filter(r=>r.turnId==='turn').forEach(r=>fullHash.add(r));
    const expectedFingerprint=legacyHash.finish();
    expect(expectedFingerprint).toBe(fullHash.finish());
    const capture=captureHistoryFeatures(snapshot,'turn');
    for await(const entry of capture.snapshot.records(signal()))void entry;
    expect(capture.fingerprint()).toBe(expectedFingerprint);
    expect(capture.result()).toMatchObject({completedActions:0,prefixComplete:false});
    expect(snapshot.coverage.complete).toBe(false);
    await snapshot.close();
  }finally{await reader.close();}
});

it('distinguishes public commentary from a final answer',async()=>{
  const message=(phase:string,id:string)=>line('response_item',{type:'message',role:'assistant',id,
    phase,turn_id:'turn',content:[{type:'output_text',text:'public message'}]});
  const f=await fixture(THREAD_A,meta(THREAD_A)+message('commentary','a')+message('final_answer','b'));
  const reader=createLocalSessionReader({root:f.root});
  try{const batch=await reader.read(THREAD_A,signal());
    expect(batch.records.map(record=>record.assistantPhase)).toEqual(['commentary','final']);
  }finally{await reader.close();}
});
it.each([false,true])('research respects outer command attribution and rejects conflicting IDs (conflict: %s)',async conflict=>{
  const start=conflict?line('event_msg',{type:'item_started',turn_id:'turn',
    item:{type:'CommandExecution',id:'x',command:'test',turn_id:'other'}}):commandStarted('x','turn');
  const f=await fixture(THREAD_A,meta(THREAD_A)+taskStarted('turn')+user('work','u','turn')+start+commandCompleted('x','turn'));
  const reader=createLocalSessionReader({root:f.root});
  try{
    const batch=await reader.read(THREAD_A,signal()),snapshot=await reader.snapshot(THREAD_A,signal());
    const capture=captureHistoryFeatures(snapshot,'turn');
    for await(const item of capture.snapshot.records(signal()))void item;
    if(conflict){expect(capture.result()).toBeNull();expect(capture.reason()).toBe('unknown_attribution');}
    else{
      const hash=createPrefixFingerprint();batch.records.filter(r=>r.turnId==='turn').forEach(r=>hash.add(r));
      expect(capture.fingerprint()).toBe(hash.finish());
      expect(capture.result()).toMatchObject({completedActions:1,outstandingActions:0});
    }
    await snapshot.close();
  }finally{await reader.close();}
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function line(type: string, payload: unknown, atMs = 1_700_000_000_000): string {
  return `${JSON.stringify({timestamp: new Date(atMs).toISOString(), type, payload})}\n`;
}

function meta(threadId: string): string {
  return line("session_meta", {id: threadId});
}

function user(text: string, id: string, turnId: string, atMs = 1_700_000_001_000): string {
  return line("response_item", {
    type: "message",
    id,
    role: "user",
    turn_id: turnId,
    content: [{type: "input_text", text}]
  }, atMs);
}

function assistant(text: string, id: string, turnId: string, atMs = 1_700_000_002_000): string {
  return line("response_item", {
    type: "message",
    id,
    role: "assistant",
    turn_id: turnId,
    content: [{type: "output_text", text}]
  }, atMs);
}

function commandStarted(actionId: string, turnId: string, command = "sleep 100", cwd?: string): string {
  return line("event_msg", {
    type: "item_started",
    turn_id: turnId,
    item: {type: "CommandExecution", id: actionId, command, ...(cwd === undefined ? {} : {cwd})}
  }, 1_700_000_003_000);
}

function commandCompleted(actionId: string, turnId: string, output = "done"): string {
  return line("event_msg", {
    type: "item_completed",
    turn_id: turnId,
    item: {type: "CommandExecution", id: actionId, status: "completed", exit_code: 0,
      aggregated_output: output}
  }, 1_700_000_004_000);
}

function customToolCall(actionId: string, turnId: string, input: unknown, type = "custom_tool_call"): string {
  return line("response_item", {
    type, id: `item-${actionId}`, call_id: actionId, name: "exec", status: "in_progress",
    input, turn_id: turnId
  }, 1_700_000_003_000);
}

function customToolOutput(actionId: string, turnId: string, output: string,
  type = "custom_tool_call_output"): string {
  return line("response_item", {
    type, id: `output-${actionId}`, call_id: actionId, output,
    metadata: {}, turn_id: turnId
  }, 1_700_000_004_000);
}

function taskStarted(turnId: string): string {
  return line("event_msg", {type: "task_started", turn_id: turnId}, 1_700_000_000_500);
}

function taskComplete(turnId: string): string {
  return line("event_msg", {type: "task_complete", turn_id: turnId}, 1_700_000_005_000);
}

async function fixture(threadId: string, contents: string, suffix = "000000"): Promise<{
  root: string;
  file: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "local-session-reader-"));
  const directory = join(root, "2026", "09", "06");
  await mkdir(directory, {recursive: true});
  const file = join(directory, `rollout-2026-09-06T00-00-00-${suffix}-${threadId}.jsonl`);
  await writeFile(file, contents, {encoding: "utf8", mode: 0o600});
  cleanups.push(() => rm(root, {recursive: true, force: true}));
  return {root, file};
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("bounded local session reader", () => {
  it("accepts observed UUIDv7 identifiers while preserving exact identity", async () => {
    const f = await fixture(THREAD_V7, meta(THREAD_V7) + user("v7 user", "v7-message", "turn-v7"));
    const reader = createLocalSessionReader({root: f.root});

    const batch = await reader.read(THREAD_V7, signal());
    expect(batch.records).toContainEqual(expect.objectContaining({kind: "user", text: "v7 user"}));
    await reader.close();
  });

  it("emits user and tool start deltas before a later tool result", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + taskStarted("turn-1") +
      user("sleep 100", "message-1", "turn-1") + commandStarted("action-1", "turn-1"));
    const reader = createLocalSessionReader({root: f.root});

    const batch = await reader.read(THREAD_A, signal());
    const started = batch.records.find(r => r.kind === "tool_start");
    expect(batch.records.some(r => r.kind === "user" && r.text === "sleep 100")).toBe(true);
    expect(batch.records).toContainEqual(expect.objectContaining({
      kind: "tool_start", actionId: "action-1", turnId: "turn-1", text: "sleep 100"
    }));
    expect(batch.records.some(r => r.kind === "tool_result")).toBe(false);
    expect((await reader.read(THREAD_A, signal())).records).toEqual([]);

    await appendFile(f.file, commandCompleted("action-1", "turn-1"));
    const result = await reader.read(THREAD_A, signal());
    const completed = result.records.find(r => r.kind === "tool_result");
    expect(result.records).toContainEqual(expect.objectContaining({
      kind: "tool_result", actionId: "action-1", text: "done"
    }));
    expect(started?.id).not.toBe(completed?.id);
    expect(completed?.actionId).toBe(started?.actionId);
    await reader.close();
  });

  it("preserves explicit normal completion provenance separately from waiting", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + taskStarted("turn-complete") +
      taskComplete("turn-complete"));
    const reader = createLocalSessionReader({root: f.root});

    const records = (await reader.read(THREAD_A, signal())).records;
    expect(records).toContainEqual(expect.objectContaining({
      kind: "runtime", turnId: "turn-complete", runtime: "waiting", outcome: "completed"
    }));
    await reader.close();
  });

  it("keeps a newer active attribution when an older turn terminates", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + taskStarted("new-turn") +
      taskComplete("old-turn") + line("response_item", {type: "message", id: "new-user", role: "user",
        content: [{type: "input_text", text: "new instruction"}]}));
    const reader = createLocalSessionReader({root: f.root});

    const records = (await reader.read(THREAD_A, signal())).records;
    expect(records).toContainEqual(expect.objectContaining({kind: "runtime", turnId: "old-turn", outcome: "completed"}));
    expect(records).toContainEqual(expect.objectContaining({kind: "user", turnId: "new-turn", text: "new instruction"}));
    await reader.close();
  });

  it("preserves authentic command provenance and pairs only the same turn", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + taskStarted("turn-provenance") +
      commandStarted("action-provenance", "turn-provenance", "node node_modules/vitest/vitest.mjs run tests/a.test.ts", "C:\\repo") +
      commandCompleted("action-provenance", "turn-provenance", '{"success":true}'));
    const reader = createLocalSessionReader({root: f.root});

    const records = (await reader.read(THREAD_A, signal())).records;
    const start = records.find(record => record.kind === "tool_start");
    const result = records.find(record => record.kind === "tool_result");
    expect(start).toMatchObject({
      actionId: "action-provenance", turnId: "turn-provenance", command: "node node_modules/vitest/vitest.mjs run tests/a.test.ts",
      cwd: "C:\\repo", startedAtMs: 1_700_000_003_000
    });
    expect(start).not.toHaveProperty("complete");
    expect(start).not.toHaveProperty("exitCode");
    expect(result).toMatchObject({
      actionId: "action-provenance", turnId: "turn-provenance", complete: true,
      exitCode: 0, output: '{"success":true}', endedAtMs: 1_700_000_004_000
    });
    expect(pairCompletedToolCapture(records)).toMatchObject({
      actionId: "action-provenance", turnId: "turn-provenance", cwd: "C:\\repo", command: "node node_modules/vitest/vitest.mjs run tests/a.test.ts",
      complete: true, exitCode: 0, startedAtMs: 1_700_000_003_000, endedAtMs: 1_700_000_004_000
    });
    await reader.close();
  });

  it("does not promote assistant JSON or clipped command output into trusted capture", async () => {
    const quoted = JSON.stringify({cwd: "C:\\quoted", command: "node fake", exitCode: 0});
    const hugeOutput = `{"success":true}${"x".repeat(70 * 1024)}`;
    const f = await fixture(THREAD_A, meta(THREAD_A) + assistant(quoted, "assistant-json", "turn-json") +
      commandStarted("action-clipped", "turn-clipped", "node node_modules/vitest/vitest.mjs run tests/a.test.ts", "C:\\repo") +
      commandCompleted("action-clipped", "turn-clipped", hugeOutput));
    const reader = createLocalSessionReader({root: f.root});

    const records = (await reader.read(THREAD_A, signal())).records;
    const assistantRecord = records.find(record => record.kind === "assistant");
    const result = records.find(record => record.actionId === "action-clipped" && record.kind === "tool_result");
    expect(assistantRecord).not.toHaveProperty("cwd");
    expect(assistantRecord).not.toHaveProperty("command");
    expect(result).toMatchObject({complete: true, outputComplete: false});
    expect(pairCompletedToolCapture(records)).toBeNull();
    await reader.close();
  });

  it("keeps equal text from distinct turns as distinct messages", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + taskStarted("turn-1") +
      user("repeat", "message-1", "turn-1") + taskComplete("turn-1") +
      taskStarted("turn-2") + user("repeat", "message-2", "turn-2"));
    const reader = createLocalSessionReader({root: f.root});

    const users = (await reader.read(THREAD_A, signal())).records.filter(r => r.kind === "user");
    expect(users).toHaveLength(2);
    expect(users.map(r => r.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(users[0]?.id).not.toBe(users[1]?.id);
    await reader.close();
  });

  it("normalizes custom and function tool call pairs without evaluating input", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + taskStarted("turn-tool") +
      customToolCall("call-1", "turn-tool", {command: "echo data-only"}) +
      customToolCall("call-2", "turn-tool", '{"command":"function data-only"}', "function_call"));
    const reader = createLocalSessionReader({root: f.root});

    const started = await reader.read(THREAD_A, signal());
    expect(started.records).toContainEqual(expect.objectContaining({
      kind: "tool_start", actionId: "call-1", text: '{"command":"echo data-only"}'
    }));
    expect(started.records).toContainEqual(expect.objectContaining({
      kind: "tool_start", actionId: "call-2", text: '{"command":"function data-only"}'
    }));
    expect(started.records.some(r => r.kind === "tool_result")).toBe(false);

    await appendFile(f.file, customToolOutput("call-1", "turn-tool", "output data"));
    const output = await reader.read(THREAD_A, signal());
    expect(output.records).toContainEqual(expect.objectContaining({
      kind: "tool_result", actionId: "call-1", text: "output data"
    }));
    await reader.close();
  });

  it("extracts an exact current-turn create_thread delegation as task data", async () => {
    const task = "actual task text: implement Map<string, Item>\nCompare a < b and render <div>results</div>.";
    const output = `<codex_delegation>\n  <source_thread_id>${PARENT_THREAD}</source_thread_id>\n  <input>${task}</input>\n</codex_delegation>`;
    const f = await fixture(CHILD_THREAD, meta(CHILD_THREAD) + taskStarted("current-turn") + line("response_item", {
      type: "function_call_output", id: "fco_uuid", name: "create_thread", namespace: "codex_app", output,
      internal_chat_message_metadata_passthrough: {turn_id: "current-turn", create_time: 1_700_000_004_000}
    }));
    const reader = createLocalSessionReader({root: f.root});

    const records = (await reader.read(CHILD_THREAD, signal())).records;
    expect(records).toContainEqual(expect.objectContaining({
      kind: "tool_result", actionId: "fco_uuid", turnId: "current-turn", text: output
    }));
    expect(records).toContainEqual(expect.objectContaining({
      kind: "user", turnId: "current-turn", text: task
    }));
    expect(records.filter(record => record.text === task)).toHaveLength(1);
    expect((await reader.read(CHILD_THREAD, signal())).records).toEqual([]);
    await reader.close();
  });

  it("retains a middle delegated task through reader, assembly, and packing", async () => {
    const delegatedTask = "DELEGATED TASK: preserve the actual child requirements";
    const output = `<codex_delegation>\n  <source_thread_id>${PARENT_THREAD}</source_thread_id>\n  <input>${delegatedTask}</input>\n</codex_delegation>`;
    const initialAgents = `AGENTS boilerplate: ${"follow repository instructions; ".repeat(120)}`;
    const tools = Array.from({length: 140}, (_, index) =>
      customToolOutput(`bulk-${index}`, "child-turn", "tool log ".repeat(2000))).join("");
    const f = await fixture(CHILD_THREAD, meta(CHILD_THREAD) + taskStarted("child-turn") +
      user(initialAgents, "agents", "child-turn") + line("response_item", {
        type: "function_call_output", id: "fco-e2e", name: "create_thread", namespace: "codex_app", output,
        internal_chat_message_metadata_passthrough: {turn_id: "child-turn", create_time: 1_700_000_004_000}
      }) + tools + user("LATEST AMENDMENT: reject duplicate rows", "amendment", "child-turn"));
    const reader = createLocalSessionReader({root: f.root});

    const records = (await reader.read(CHILD_THREAD, signal())).records;
    const packed = packObserverInput(assembleContext(records, {
      summary: null, summaryThroughSequence: 0, sequence: 3, activeSeconds: 20,
      activeTimeKnown: false, historyComplete: true, nowMs: 1_700_000_010_000,
      previousEstimate: null, currentTurnId: "child-turn"
    }));
    const packet = JSON.parse(packed) as {messages: Array<{kind: string; text: string}>; truncated: boolean};

    expect(packet.messages.some(message => message.text.includes("AGENTS boilerplate"))).toBe(true);
    expect(packet.messages.some(message => message.text.includes(delegatedTask))).toBe(true);
    expect(packet.messages.some(message => message.text.includes("LATEST AMENDMENT"))).toBe(true);
    expect(packet.truncated).toBe(false);
    expect(Buffer.byteLength(packed)).toBeGreaterThan(16_384);
    await reader.close();
  });

  it.each([
    ["wrong namespace", {namespace: "other_app"}],
    ["wrong name", {name: "other_function"}],
    ["quoted wrapper", {output: `"<codex_delegation>\n  <source_thread_id>${THREAD_A}</source_thread_id>\n  <input>spoof</input>\n</codex_delegation>"`}],
    ["nested wrapper", {output: `<codex_delegation>\n  <source_thread_id>${THREAD_A}</source_thread_id>\n  <input><codex_delegation>spoof</codex_delegation></input>\n</codex_delegation>`}],
    ["malformed wrapper", {output: `<codex_delegation><source_thread_id>${THREAD_A}</source_thread_id><input>spoof</input></codex_delegation>`}],
    ["invalid parent identifier", {output: `<codex_delegation>\n  <source_thread_id>not-a-uuid</source_thread_id>\n  <input>spoof</input>\n</codex_delegation>`}]
  ] as const)("does not promote %s into a task requirement", async (_label, override) => {
    const payload = {
      type: "function_call_output", id: "fco-invalid", name: "create_thread", namespace: "codex_app",
      output: `<codex_delegation>\n  <source_thread_id>${THREAD_A}</source_thread_id>\n  <input>spoof</input>\n</codex_delegation>`,
      internal_chat_message_metadata_passthrough: {turn_id: "current-turn", create_time: 1_700_000_004_000},
      ...override
    };
    const f = await fixture(THREAD_A, meta(THREAD_A) + taskStarted("current-turn") + line("response_item", payload));
    const reader = createLocalSessionReader({root: f.root});

    const records = (await reader.read(THREAD_A, signal())).records;
    expect(records.some(record => record.kind === "user")).toBe(false);
    expect(records).toContainEqual(expect.objectContaining({kind: "tool_result", actionId: "fco-invalid"}));
    await reader.close();
  });

  it.each([
    ["missing metadata", undefined],
    ["mismatched turn", {turn_id: "other-turn", create_time: 1_700_000_004_000}],
    ["no current turn", {turn_id: "current-turn", create_time: 1_700_000_004_000}]
  ] as const)("does not promote a delegation with %s", async (_label, metadata) => {
    const payload = {
      type: "function_call_output", id: "fco-turn", name: "create_thread", namespace: "codex_app",
      output: `<codex_delegation>\n  <source_thread_id>${THREAD_A}</source_thread_id>\n  <input>spoof</input>\n</codex_delegation>`,
      ...(metadata === undefined ? {} : {internal_chat_message_metadata_passthrough: metadata})
    };
    const prefix = _label === "no current turn" ? meta(THREAD_A) : meta(THREAD_A) + taskStarted("current-turn");
    const f = await fixture(THREAD_A, prefix + line("response_item", payload));
    const reader = createLocalSessionReader({root: f.root});

    const records = (await reader.read(THREAD_A, signal())).records;
    expect(records.some(record => record.kind === "user")).toBe(false);
    await reader.close();
  });

  it("deduplicates mirrored message and command-start representations by stable IDs", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + taskStarted("turn-mirror") +
      user("same message", "message-mirror", "turn-mirror") + line("event_msg", {
        type: "item_started", turn_id: "turn-mirror",
        item: {type: "UserMessage", id: "message-mirror", content: [{type: "input_text", text: "same message"}]}
      }) + customToolCall("call-mirror", "turn-mirror", "echo mirror") + line("event_msg", {
        type: "item_started", turn_id: "turn-mirror",
        item: {type: "CommandExecution", id: "call-mirror", command: "echo mirror"}
      }));
    const reader = createLocalSessionReader({root: f.root});

    const records = (await reader.read(THREAD_A, signal())).records;
    expect(records.filter(r => r.kind === "user")).toHaveLength(1);
    expect(records.filter(r => r.kind === "tool_start")).toHaveLength(1);
    await reader.close();
  });

  it("ignores reasoning, environment, system, and developer content", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + user("visible", "visible", "turn-visible") +
      line("response_item", {type: "reasoning", id: "reasoning", summary: [{text: "hidden"}]}) +
      line("response_item", {type: "message", id: "system", role: "system",
        content: [{type: "input_text", text: "hidden system"}]}) +
      line("response_item", {type: "message", id: "developer", role: "developer",
        content: [{type: "input_text", text: "hidden developer"}]}) +
      line("response_item", {type: "environment", id: "environment", cwd: "private"}));
    const reader = createLocalSessionReader({root: f.root});

    const records = (await reader.read(THREAD_A, signal())).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({kind: "user", text: "visible"});
    await reader.close();
  });

  it("reads old history and preserves separate conversation identities", async () => {
    const a = await fixture(THREAD_A, meta(THREAD_A) + user("old A", "a-1", "turn-a"), "a");
    const b = await fixture(THREAD_B, meta(THREAD_B) + user("old B", "b-1", "turn-b"), "b");
    const reader = createLocalSessionReader({root: a.root});
    await mkdir(join(a.root, "2026", "09", "06"), {recursive: true});
    await writeFile(join(a.root, "2026", "09", "06", `rollout-2026-09-06T00-00-01-${THREAD_B}.jsonl`),
      await readFile(b.file));

    const recordsA = (await reader.read(THREAD_A, signal())).records;
    const recordsB = (await reader.read(THREAD_B, signal())).records;
    expect(recordsA).toContainEqual(expect.objectContaining({kind: "user", text: "old A"}));
    expect(recordsB).toContainEqual(expect.objectContaining({kind: "user", text: "old B"}));
    expect(recordsA).not.toContainEqual(expect.objectContaining({text: "old B"}));
    await reader.close();
  });

  it("waits for a newline and completes a split UTF-8 record", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A));
    const record = Buffer.from(user("café", "utf8-1", "turn-utf8"));
    const marker = Buffer.from("é");
    const markerAt = record.indexOf(marker);
    expect(markerAt).toBeGreaterThan(0);
    await appendFile(f.file, record.subarray(0, markerAt + 1));
    const reader = createLocalSessionReader({root: f.root});

    const partial = await reader.read(THREAD_A, signal());
    expect(partial.records).toEqual([]);
    expect(partial.partialLine).toBe(true);
    await appendFile(f.file, record.subarray(markerAt + 1));

    const complete = await reader.read(THREAD_A, signal());
    expect(complete.records).toContainEqual(expect.objectContaining({kind: "user", text: "café"}));
    expect(complete.partialLine).toBe(false);
    await reader.close();
  });

  it("reports reset after truncation and replacement instead of using a stale offset", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + user("before", "before", "turn-1"));
    const reader = createLocalSessionReader({root: f.root});
    await reader.read(THREAD_A, signal());

    await writeFile(f.file, "");
    const truncated = await reader.read(THREAD_A, signal());
    expect(truncated.reset).toBe(true);
    expect(truncated.records).toEqual([]);

    await writeFile(f.file, meta(THREAD_A) + user("after", "after", "turn-2"));
    const replaced = await reader.read(THREAD_A, signal());
    expect(replaced.reset).toBe(true);
    expect(replaced.records).toContainEqual(expect.objectContaining({kind: "user", text: "after"}));
    expect(replaced.records).not.toContainEqual(expect.objectContaining({text: "before"}));
    await reader.close();
  });

  it("rejects ambiguous candidates and mismatched session identity without leaking paths", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + user("private A", "a", "turn-a"), "a");
    await writeFile(join(f.root, "2026", "09", "06", `rollout-2026-09-06T00-00-01-${THREAD_A}.jsonl`),
      meta(THREAD_A) + user("private B", "b", "turn-b"));
    const reader = createLocalSessionReader({root: f.root});
    const ambiguous = await reader.read(THREAD_A, signal()).catch(error => error);
    expect(ambiguous).toMatchObject({code: "source_ambiguous"});
    expect(String(ambiguous)).not.toContain("private");
    await reader.close();

    const mismatch = await fixture(THREAD_B, meta(THREAD_A) + user("secret", "x", "turn-x"));
    const mismatchReader = createLocalSessionReader({root: mismatch.root});
    const error = await mismatchReader.read(THREAD_B, signal()).catch(caught => caught);
    expect(error).toMatchObject({code: "source_identity_mismatch"});
    expect(String(error)).not.toContain("secret");
    await mismatchReader.close();
  });

  it("rejects a symlinked date directory without following it", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-session-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "local-session-outside-"));
    cleanups.push(() => rm(root, {recursive: true, force: true}));
    cleanups.push(() => rm(outside, {recursive: true, force: true}));
    await mkdir(join(root, "2026", "09"), {recursive: true});
    try {
      await symlink(outside, join(root, "2026", "09", "06"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const reader = createLocalSessionReader({root});
    const error = await reader.read(THREAD_A, signal()).catch(caught => caught);
    expect(error).toMatchObject({code: "source_unsafe_path"});
    await reader.close();
  });

  it("rejects lexical traversal and caps directory discovery", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A));
    const reader = createLocalSessionReader({root: f.root});
    const traversal = await reader.read("../" + THREAD_A, signal()).catch(error => error);
    expect(traversal).toMatchObject({code: "source_invalid_thread"});
    await reader.close();

    const limitedRoot = await mkdtemp(join(tmpdir(), "local-session-limit-"));
    cleanups.push(() => rm(limitedRoot, {recursive: true, force: true}));
    await Promise.all(Array.from({length: 4_097}, (_, i) =>
      writeFile(join(limitedRoot, `entry-${i}`), "", {mode: 0o600})));
    const limitedReader = createLocalSessionReader({root: limitedRoot});
    const limited = await limitedReader.read(THREAD_A, signal()).catch(error => error);
    expect(limited).toMatchObject({code: "source_limit"});
    await limitedReader.close();
  });

  it("maps cancellation to a sanitized source error", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A));
    const reader = createLocalSessionReader({root: f.root});
    const controller = new AbortController();
    controller.abort();
    const error = await reader.read(THREAD_A, controller.signal).catch(caught => caught);
    expect(error).toMatchObject({code: "source_cancelled"});
    expect(String(error)).not.toContain(f.file);
    await reader.close();
  });

  it("skips an oversized compacted line across bounded passes and flags history loss", async () => {
    const compacted = line("compacted", {summary: "x".repeat(5 * 1024 * 1024)});
    const f = await fixture(THREAD_A, meta(THREAD_A) + compacted + user("current prompt", "current", "turn-current"));
    const reader = createLocalSessionReader({root: f.root});
    const first = await reader.read(THREAD_A, signal());
    expect(first.records.some(r => r.text === "current prompt")).toBe(false);
    expect(first.historyTruncated).toBe(true);
    expect(first.caughtUp).toBe(false);

    const second = await reader.read(THREAD_A, signal());
    expect(second.records).toContainEqual(expect.objectContaining({kind: "user", text: "current prompt"}));
    expect(second.historyTruncated).toBe(true);
    await reader.close();
  });

  it("uses a fixed-size hashed deduplication window and flags its history loss", async () => {
    const history = Array.from({length: 4_100}, (_, i) => user(`message-${i}`, `message-${i}`, `turn-${i}`)).join("");
    const f = await fixture(THREAD_A, meta(THREAD_A) + history);
    const reader = createLocalSessionReader({root: f.root});

    const batch = await reader.read(THREAD_A, signal());
    expect(batch.records.filter(r => r.kind === "user")).toHaveLength(4_100);
    expect(batch.historyTruncated).toBe(true);
    await appendFile(f.file, user("message-0", "message-0", "turn-0"));
    const reread = await reader.read(THREAD_A, signal());
    expect(reread.records).toContainEqual(expect.objectContaining({kind: "user", text: "message-0"}));
    expect(reread.historyTruncated).toBe(true);
    await reader.close();
  });

  it("rejects malformed complete JSON without exposing the malformed content", async () => {
    const secret = "malformed-private-content";
    const f = await fixture(THREAD_A, meta(THREAD_A) + `{not-json-${secret}}\n`);
    const reader = createLocalSessionReader({root: f.root});
    const error = await reader.read(THREAD_A, signal()).catch(caught => caught);
    expect(error).toMatchObject({code: "source_malformed"});
    expect(String(error)).not.toContain(secret);
    await reader.close();
  });

  it("continues a history scan in bounded passes", async () => {
    const history = Array.from({length: 1_500}, (_, i) =>
      user(`${"x".repeat(4_000)}-${i}`, `message-${i}`, `turn-${i}`)).join("");
    const f = await fixture(THREAD_A, meta(THREAD_A) + history);
    const reader = createLocalSessionReader({root: f.root});
    const first = await reader.read(THREAD_A, signal());
    expect(first.records.length).toBeGreaterThan(0);
    expect(first.caughtUp).toBe(false);
    let total = first.records.length;
    for (let i = 0; i < 10 && !first.caughtUp; i += 1) {
      const next = await reader.read(THREAD_A, signal());
      total += next.records.length;
      if (next.caughtUp) break;
    }
    expect(total).toBe(1_500);
    await reader.close();
  });

  it("removes a cursor, rejects reads after close, and makes close idempotent", async () => {
    const f = await fixture(THREAD_A, meta(THREAD_A) + user("once", "once", "turn-1"));
    const reader = createLocalSessionReader({root: f.root});
    await reader.read(THREAD_A, signal());
    reader.remove(THREAD_A);
    expect((await reader.read(THREAD_A, signal())).records).toContainEqual(
      expect.objectContaining({kind: "user", text: "once"})
    );
    await reader.close();
    await expect(reader.close()).resolves.toBeUndefined();
    await expect(reader.read(THREAD_A, signal())).rejects.toMatchObject({code: "source_closed"});
  });
});
