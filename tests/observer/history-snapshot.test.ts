import {appendFile, mkdir, mkdtemp, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import type {HistoryRecord, HistorySnapshot} from "../../src/observer/history-snapshot.js";
import {createHistorySnapshot} from "../../src/observer/history-snapshot.js";
import {createLocalSessionReader} from "../../src/observer/local-session-reader.js";

const THREAD = "11111111-1111-4111-8111-111111111111";
const cleanups: Array<() => Promise<void>> = [];

type SnapshotReader = ReturnType<typeof createLocalSessionReader> & {
  snapshot(threadId: string, signal: AbortSignal): Promise<HistorySnapshot>;
};

function line(type: string, payload: unknown, atMs = 1_700_000_000_000): string {
  return `${JSON.stringify({timestamp: new Date(atMs).toISOString(), type, payload})}\n`;
}

function meta(): string {
  return line("session_meta", {id: THREAD});
}

function message(role: "user" | "assistant", text: string, id: string, turnId = "turn-1"): string {
  return line("response_item", {
    type: "message", id, role, turn_id: turnId,
    content: [{type: role === "user" ? "input_text" : "output_text", text}]
  });
}

function toolResult(output: string, actionId = "large-tool", turnId = "turn-1"): string {
  return line("response_item", {
    type: "custom_tool_call_output", id: `output-${actionId}`, call_id: actionId,
    output, turn_id: turnId
  });
}

function checkpoint(label: string, includeImage = false): string {
  const items: Array<Record<string, unknown>> = [
    {type: "message", role: "user", content: [{type: "input_text", text: `checkpoint-${label}`}]},
    {type: "compaction", encrypted_content: `encrypted-${label}`}
  ];
  if (includeImage) {
    items.push({type: "message", role: "assistant", content: [
      {type: "input_image", image_url: "data:image/png;base64,AA=="}
    ]});
  }
  return line("compacted", {
    replacement_history: items,
    guardian_history: [{private: "must-not-be-imported"}]
  });
}

async function fixture(contents: string): Promise<{root: string; file: string}> {
  const root = await mkdtemp(join(tmpdir(), "history-snapshot-"));
  const directory = join(root, "2026", "09", "06");
  await mkdir(directory, {recursive: true});
  const file = join(directory, `rollout-2026-09-06T00-00-00-${THREAD}.jsonl`);
  await writeFile(file, contents, {encoding: "utf8", mode: 0o600});
  cleanups.push(() => rm(root, {recursive: true, force: true}));
  return {root, file};
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("source-backed history snapshots", () => {
  it.each([false,true])('rejects a same-length interior checkpoint rewrite on every replay (empty suffix=%s)',async emptySuffix=>{
    const original=meta()+checkpoint('x'.repeat(2*1024*1024))+(emptySuffix?'':message('user','current','u'));
    const f=await fixture(original),reader=createLocalSessionReader({root:f.root});let snapshot;
    try{
      snapshot=await reader.snapshot(THREAD,signal());
      for await(const _ of snapshot.records(signal())){}
      const middle=1024*1024;
      await writeFile(f.file,original.slice(0,middle)+'y'+original.slice(middle+1));
      await expect((async()=>{for await(const _ of snapshot!.records(signal())){}})()).rejects.toMatchObject({code:'source_identity_mismatch'});
    }finally{await snapshot?.close();await reader.close();}
  });

  it('does not revive an older checkpoint past a newer legacy compaction marker',async()=>{
    const f=await fixture(meta()+checkpoint('old')+line('compacted',{message:'legacy truncated'})+message('user','current','u'));
    const reader=createLocalSessionReader({root:f.root});let snapshot;
    try{
      snapshot=await reader.snapshot(THREAD,signal());
      for await(const _ of snapshot.records(signal())){}
      expect(snapshot.coverage.complete).toBe(false);
      expect(snapshot.coverage.gaps).toContain('upstream_truncated');
    }finally{await snapshot?.close();await reader.close();}
  });

  it.each(['item_started','item_completed'] as const)('preserves MCP tool records as data: %s',async eventType=>{
    const raw={type:'McpToolCall',id:'mcp-1',server:'fixture',tool:'read',status:'completed',
      arguments:{query:'retain arguments'},result:{content:[{type:'text',text:'retain result'}]},
      pluginId:'fixture-plugin',duration:{secs:1,nanos:0}};
    const f=await fixture(meta()+line('event_msg',{type:eventType,thread_id:THREAD,turn_id:'turn-1',item:raw}));
    const reader=createLocalSessionReader({root:f.root});let snapshot:HistorySnapshot|undefined;
    try{
      snapshot=await reader.snapshot(THREAD,signal());const records=[];
      for await(const item of snapshot.records(signal()))records.push(item.record);
      expect(snapshot.coverage).toMatchObject({complete:true,gaps:[]});
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({kind:eventType==='item_completed'?'tool_result':'tool_start',sourceTurnId:'turn-1',toolName:'codex:McpToolCall'});
      expect(JSON.parse(records[0]!.text!)).toEqual(raw);
    }finally{await snapshot?.close();await reader.close();}
  });

  it('does not deduplicate a newly unsupported image as an unchanged text message',async()=>{
    const f=await fixture(meta()+message('user','same','u')+line('response_item',{
      type:'message',id:'u',role:'user',turn_id:'turn-1',content:[{type:'input_text',text:'same'},{type:'input_image',path:'invalid-shape'}]}));
    const reader=createLocalSessionReader({root:f.root});
    try{const live=await reader.read(THREAD,signal());expect(live.records.some(record=>record.imageContextPending)).toBe(true);}
    finally{await reader.close();}
  });
  it.each([
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'local_image',path:'C:/synthetic.png'}]}},
    {type:'event_msg',payload:{type:'item_completed',item:{type:'AgentMessage',role:'user',content:[{type:'local_image',path:'C:/synthetic.png'}]}}},
    {type:'event_msg',payload:{type:'item_completed',item:{type:'AgentMessage',content:[{type:'local_image',path:'C:/synthetic.png'}]}}}
  ])('rejects non-user attachment provenance: $type $payload.type',async envelope=>{
    const f=await fixture(meta()+message('user','inspect','u')+line(envelope.type,envelope.payload));
    const reader=createLocalSessionReader({root:f.root});let snapshot:HistorySnapshot|undefined;
    try{
      const live=await reader.read(THREAD,signal());
      expect(live.records.some(record=>(record as any).imageContextPending===true)).toBe(true);
      snapshot=await reader.snapshot(THREAD,signal());const records=[];
      for await(const item of snapshot.records(signal()))records.push(item.record);
      expect(snapshot.coverage.complete).toBe(false);
      expect(records.some(record=>record.contentParts?.some(part=>part.type==='local_image'))).toBe(false);
    }finally{await snapshot?.close();await reader.close();}
  });
  it('exposes bounded image identity from live reads without retaining image bytes',async()=>{
    const f=await fixture(meta()+line('event_msg',{type:'item_completed',turn_id:'turn-1',item:{type:'UserMessage',id:'live-image',content:[{type:'input_image',image_url:'data:image/png;base64,AA=='}]}}));
    const reader=createLocalSessionReader({root:f.root});
    try{
      const batch=await reader.read(THREAD,signal());const record=batch.records.find(r=>r.id==='live-image');
      expect(record).toMatchObject({imageCount:1,imageFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
      expect(JSON.stringify(record)).not.toContain('base64');
    }finally{await reader.close();}
  });
  it('preserves embedded images and distinguishes changed attachments from duplicate replay',async()=>{
    const msg=(url:string)=>line('response_item',{type:'message',role:'user',id:'same',turn_id:'turn-1',content:[
      {type:'input_text',text:'inspect'},{type:'input_image',image_url:url}]});
    const f=await fixture(meta()+msg('data:image/png;base64,AA==')+msg('data:image/png;base64,AA==')+msg('data:image/png;base64,AQ=='));
    const reader=createLocalSessionReader({root:f.root});const snapshot=await reader.snapshot(THREAD,signal());
    try {
      const records=[];for await(const item of snapshot.records(signal()))records.push(item.record);
      expect(records).toHaveLength(2);
      expect(records.map(r=>r.contentParts?.[1])).toEqual([
        {type:'input_image',imageUrl:'data:image/png;base64,AA=='},
        {type:'input_image',imageUrl:'data:image/png;base64,AQ=='}]);
      expect(snapshot.coverage).toEqual({complete:true,gaps:[]});
    }finally{await snapshot.close();await reader.close();}
  });
  it.each([{type:'local_image',path:''},{type:'input_image',path:'not-a-url'}])('does not accept malformed image content %j', async part => {
    const f=await fixture(meta()+line('response_item',{type:'message',role:'user',id:'bad-image',turn_id:'turn-1',content:[part]}));
    const reader=createLocalSessionReader({root:f.root});const snapshot=await reader.snapshot(THREAD,signal());
    try {
      for await(const _item of snapshot.records(signal())) { /* consume fixed watermark */ }
      expect(snapshot.coverage.complete).toBe(false);
      expect(snapshot.coverage.gaps).toContain('unreadable_record');
    } finally {await snapshot.close();await reader.close();}
  });
  it.each([false,true])('retains ordered native image content after a checkpoint (imageOnly=%s)', async imageOnly => {
    const content=imageOnly?[{type:'local_image',path:'C:/fixture/image.png'}]:[
      {type:'text',text:'before'},{type:'local_image',path:'C:/fixture/image.png'},{type:'text',text:'after'}];
    const f=await fixture(meta()+checkpoint('image')+line('event_msg',{
      type:'item_completed',turn_id:'turn-1',item:{type:'UserMessage',id:'image-message',content}
    }));
    const reader=createLocalSessionReader({root:f.root});
    const snapshot=await reader.snapshot(THREAD,signal());
    try {
      const records=[];for await(const item of snapshot.records(signal()))records.push(item.record);
      expect(snapshot.coverage).toEqual({complete:true,gaps:[]});
      expect(records.find(r=>r.id==='image-message')).toMatchObject({
        text:imageOnly?'':'beforeafter',contentParts:content
      });
    } finally {await snapshot.close();await reader.close();}
  });

  it("preserves native file, collaboration and conversation metadata after a checkpoint", async () => {
    const events = [
      line('event_msg', {type:'thread_settings_applied', thread_id:THREAD, thread_settings:{model:'test-model'}}),
      line('event_msg', {type:'thread_goal_updated', threadId:THREAD, goal:{objective:'finish fixture',status:'active'}}),
      line('event_msg', {type:'token_count', info:{total_token_usage:{total_tokens:10}},rate_limits:null}),
      line('event_msg', {type:'item_completed',thread_id:THREAD,turn_id:'turn-1',started_at_ms:100,completed_at_ms:200,item:{type:'ContextCompaction',id:'compact'}}),
      line('event_msg', {type:'item_completed',turn_id:'turn-1',item:{type:'AgentMessage',id:'agent-text',content:[{type:'Text',text:'native capitalized text'}],phase:'commentary'}}),
      JSON.stringify({type:'event_msg',timestamp:'2026-09-13T00:00:00.000Z',ordinal:42,payload:{type:'item_completed',thread_id:THREAD,turn_id:'turn-1',item:{type:'Extension',kind:'clock.sleep',id:'sleep',durationMs:100000,detail:'retain extension detail'}}})+'\n',
      line('event_msg', {type:'item_completed',turn_id:'turn-1',item:{type:'FileChange',id:'patch',changes:{'a.ts':{type:'update',diff:'+fixture'}},status:'completed',stdout:'patched',stderr:''}}),
      line('event_msg', {type:'item_completed',turn_id:'turn-1',item:{type:'CollabAgentToolCall',id:'collab',tool:'wait',status:'completed',sender_thread_id:THREAD,receiver_thread_ids:['child'],receiver_agents:[],agents_states:{child:{status:'completed',message:'fixture reviewed'}}}}),
    ].join('');
    const f = await fixture(meta()+checkpoint('native')+events+message('user','continue','current'));
    const reader = createLocalSessionReader({root:f.root});
    const snapshot = await reader.snapshot(THREAD,signal());
    try {
      const records=[];
      for await(const item of snapshot.records(signal())) records.push(item.record);
      expect(snapshot.coverage).toEqual({complete:true,gaps:[]});
      expect(records.map(r=>r.text).join('\n')).toContain('+fixture');
      expect(records.map(r=>r.text).join('\n')).toContain('fixture reviewed');
      expect(records.map(r=>r.text).join('\n')).toContain('finish fixture');
      expect(records.map(r=>r.text).join('\n')).toContain('test-model');
      expect(records.map(r=>r.text).join('\n')).toContain('native capitalized text');
      expect(records.map(r=>r.text).join('\n')).toContain('retain extension detail');
      expect(records.find(r=>r.toolName==='codex:Extension:clock.sleep')).toMatchObject({kind:'tool_result',sourceTurnId:'turn-1'});
      expect(JSON.parse(records.find(r=>r.toolName==='codex:Extension:clock.sleep')!.text!)).toMatchObject({ordinal:42,type:'event_msg',timestamp:'2026-09-13T00:00:00.000Z'});
      expect(records.some(r=>r.runtime!==undefined||r.outcome!==undefined)).toBe(false);
      expect(records.filter(r=>r.turnId===null&&r.sourceTurnId==null)).toHaveLength(2);
      const live = await reader.read(THREAD,signal());
      expect(live.records.some(r=>r.sourceScope==='conversation'||r.toolName?.startsWith('codex:'))).toBe(false);
    } finally {await snapshot.close();await reader.close();}
  });

  it("does not accept a source-supplied conversation scope on an unattributed message", async () => {
    const f=await fixture(meta()+checkpoint('scope')+line('response_item',{
      type:'message',role:'user',id:'unattributed',sourceScope:'conversation',content:[{type:'input_text',text:'retain the gap'}]
    }));
    const reader=createLocalSessionReader({root:f.root});
    const snapshot=await reader.snapshot(THREAD,signal());
    try {
      for await(const item of snapshot.records(signal())) expect(item.record.sourceScope).toBeUndefined();
      expect(snapshot.coverage).toEqual({complete:false,gaps:['unattributed_record']});
    } finally {await snapshot.close();await reader.close();}
  });

  it.each([
    {type:'token_count',info:null,rate_limits:null,unexpected_content:'must not disappear'},
    {type:'token_count',info:['must not disappear'],rate_limits:null},
    {type:'token_count',info:null,rate_limits:['must not disappear']},
    {type:'thread_goal_updated',threadId:'different-thread',goal:{objective:'foreign'}},
    {type:'item_completed',item:{type:'FileChange',id:'broken',status:'completed'}},
    {type:'item_completed',item:{type:'McpToolCall',id:'m',server:'s',tool:'t',status:'completed',result:null}},
    {type:'item_completed',item:{type:'McpToolCall',id:'m',server:'s',tool:'t',status:'completed',arguments:{}}},
    {type:'item_completed',thread_id:'foreign',item:{type:'McpToolCall',id:'m',server:'s',tool:'t',status:'completed',arguments:{},result:null}},
    {type:'item_completed',item:{type:'McpToolCall',id:'m',server:'s',tool:'t',status:'completed',arguments:{},result:null,thread_id:'foreign'}},
    {type:'item_completed',turn_id:'a',turnId:'b',item:{type:'McpToolCall',id:'m',server:'s',tool:'t',status:'completed',arguments:{},result:null}},
    {type:'item_completed',turn_id:'a',item:{type:'McpToolCall',id:'m',server:'s',tool:'t',status:'completed',arguments:{},result:null,turnId:'b'}},
    {type:'item_completed',turn_id:'',item:{type:'McpToolCall',id:'m',server:'s',tool:'t',status:'completed',arguments:{},result:null}},
    {type:'item_completed',item:{type:'ContextCompaction',id:'c',content:'must not disappear'}},
    {type:'item_completed',content:'must not disappear',item:{type:'ContextCompaction',id:'c'}},
    {type:'item_completed',thread_id:{content:'must not disappear'},item:{type:'ContextCompaction',id:'c'}},
    {type:'item_completed',turn_id:['content'],item:{type:'ContextCompaction',id:'c'}},
    {type:'item_completed',thread_id:'foreign',item:{type:'ContextCompaction',id:'c'}},
    {type:'item_completed',turn_id:'a',turnId:'b',item:{type:'ContextCompaction',id:'c'}},
    {type:'item_completed',started_at_ms:{content:'must not disappear'},item:{type:'ContextCompaction',id:'c'}},
    {type:'new_unknown_event',text:'future content'},
    {type:'item_completed',turn_id:'turn-1',item:{type:'Extension',kind:'clock.sleep',id:'bad',durationMs:-1}},
    {type:'item_completed',turn_id:'turn-1',item:{type:'Extension',kind:'unknown.extension',id:'bad',durationMs:1}},
    {type:'item_completed',thread_id:'foreign',turn_id:'turn-1',item:{type:'Extension',kind:'clock.sleep',id:'bad',durationMs:1}},
    {type:'item_completed',turn_id:'turn-1',item:{type:'Extension',kind:'clock.sleep',id:'bad',durationMs:1,thread_id:'foreign'}},
    {type:'item_completed',turn_id:'turn-1',item:{type:'Extension',kind:'clock.sleep',id:'bad',durationMs:1,turn_id:'turn-1',turnId:'other'}},
    {type:'item_completed',turn_id:'turn-1',started_at_ms:{text:'not a timestamp'},item:{type:'Extension',kind:'clock.sleep',id:'bad',durationMs:1}},
  ])("retains a gap for malformed, foreign or unknown native event %#", async event => {
    const f=await fixture(meta()+checkpoint('guard')+line('event_msg',event));
    const reader=createLocalSessionReader({root:f.root});
    const snapshot=await reader.snapshot(THREAD,signal());
    try {
      for await(const _item of snapshot.records(signal())) { /* finish scan */ }
      expect(snapshot.coverage.complete).toBe(false);
      expect(snapshot.coverage.gaps.length).toBeGreaterThan(0);
    } finally {await snapshot.close();await reader.close();}
  });

  it("starts a snapshot iterator at its source offset while resetting tail ordinals", async () => {
    let firstOffset = -1;
    const snapshot = createHistorySnapshot({
      identity: "offset-source",
      sourceEpoch: 1,
      revision: 1,
      startOffset: 42,
      open: () => ({
        readPage: async (offset, _signal) => {
          firstOffset = offset;
          return {
            records: [{id: "tail", turnId: "turn-1", atMs: 1, kind: "user", text: "tail"}],
            nextOffset: 43,
            done: true,
            coverage: {complete: true, gaps: []}
          };
        },
        close: async () => {}
      }),
      close: async () => {}
    });

    const entries: HistoryRecord[] = [];
    for await (const entry of snapshot.records(signal())) entries.push(entry);
    expect(firstOffset).toBe(42);
    expect(entries).toMatchObject([{ordinal: 0, record: {id: "tail"}}]);
    await snapshot.close();
  });

  it("selects the latest complete checkpoint and streams only its tail", async () => {
    const f = await fixture(meta() + message("user", "old", "old") + checkpoint("latest") +
      message("assistant", "tail", "tail"));
    const reader = createLocalSessionReader({root: f.root});
    const snapshot = await reader.snapshot(THREAD, signal());
    try {
      const received: HistoryRecord[] = [];
      for await (const entry of snapshot.records(signal())) received.push(entry);
      expect(snapshot.checkpoint).toMatchObject({
        kind: "native_compacted_window",
        sourceRepresentation: "upstream_compacted",
        itemCount: 2,
        encryptedSummaryCount: 1
      });
      expect(received.map(entry => entry.record.text)).toEqual(["tail"]);
      expect(received[0]?.ordinal).toBe(0);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("uses a newer checkpoint and changes source epoch when its fingerprint changes", async () => {
    const f = await fixture(meta() + checkpoint("first") + message("user", "between", "between"));
    const reader = createLocalSessionReader({root: f.root});
    const first = await reader.snapshot(THREAD, signal());
    const firstEpoch = first.sourceEpoch;
    await first.close();
    await appendFile(f.file, checkpoint("second") + message("user", "new tail", "new-tail"));

    const second = await reader.snapshot(THREAD, signal());
    try {
      const received: HistoryRecord[] = [];
      for await (const entry of second.records(signal())) received.push(entry);
      expect(second.checkpoint?.fingerprint).not.toBe(first.checkpoint?.fingerprint);
      expect(second.sourceEpoch).not.toBe(firstEpoch);
      expect(received.map(entry => entry.record.text)).toEqual(["new tail"]);
    } finally {
      await second.close();
      await reader.close();
    }
  });

  it("fails explicitly when the latest checkpoint is malformed", async () => {
    const malformed = line("compacted", {replacement_history: [{type: "future_item"}]});
    const f = await fixture(meta() + checkpoint("valid") + malformed + message("user", "tail", "tail"));
    const reader = createLocalSessionReader({root: f.root});
    try {
      await expect(reader.snapshot(THREAD, signal())).rejects.toMatchObject({code: "source_checkpoint_unsupported"});
    } finally {
      await reader.close();
    }
  });

  it("allows an older malformed checkpoint when a newer valid one supersedes it", async () => {
    const malformed = line("compacted", {replacement_history: [{type: "future_item"}]});
    const f = await fixture(meta() + malformed + checkpoint("newer-valid") +
      message("user", "new tail", "new-tail"));
    const reader = createLocalSessionReader({root: f.root});
    const snapshot = await reader.snapshot(THREAD, signal());
    try {
      const received: HistoryRecord[] = [];
      for await (const entry of snapshot.records(signal())) received.push(entry);
      expect(snapshot.checkpoint?.items[1]).toEqual({
        type: "compaction",
        encrypted_content: "encrypted-newer-valid"
      });
      expect(received.map(entry => entry.record.text)).toEqual(["new tail"]);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("fails closed on an unreadable complete line after a checkpoint", async () => {
    const unreadable = '{"type":"compacted","payload":{"replacement_history":[}\n';
    const f = await fixture(meta() + checkpoint("old") + unreadable +
      message("user", "tail", "tail"));
    const reader = createLocalSessionReader({root: f.root});
    try {
      await expect(reader.snapshot(THREAD, signal())).rejects.toMatchObject({code: "source_checkpoint_unsupported"});
    } finally {
      await reader.close();
    }
  });

  it("fails closed on an oversized complete line after a checkpoint", async () => {
    const oversized = "{\"type\":\"compacted\",\"payload\":{\"replacement_history\":[{\"type\":\"compaction\",\"encrypted_content\":\"" +
      "x".repeat(16 * 1024 * 1024) +
      "\"}]}}\n";
    const f = await fixture(meta() + checkpoint("old") + oversized + message("user", "tail", "tail"));
    const reader = createLocalSessionReader({root: f.root});
    try {
      await expect(reader.snapshot(THREAD, signal())).rejects.toMatchObject({code: "source_checkpoint_unsupported"});
    } finally {
      await reader.close();
    }
  });

  it("keeps the checkpoint and tail bounded by the snapshot watermark", async () => {
    const f = await fixture(meta() + checkpoint("fixed") + message("user", "before-watermark", "before"));
    const reader = createLocalSessionReader({root: f.root});
    const snapshot = await reader.snapshot(THREAD, signal());
    await appendFile(f.file, checkpoint("newer") + message("user", "after-watermark", "after"));
    try {
      const received: HistoryRecord[] = [];
      for await (const entry of snapshot.records(signal())) received.push(entry);
      expect(snapshot.checkpoint?.fingerprint).toBeDefined();
      expect(received.map(entry => entry.record.text)).toEqual(["before-watermark"]);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("bumps source epoch for a repeated identical checkpoint at a new offset", async () => {
    const repeated = checkpoint("same");
    const f = await fixture(meta() + repeated + message("user", "first tail", "first"));
    const reader = createLocalSessionReader({root: f.root});
    const first = await reader.snapshot(THREAD, signal());
    const firstEpoch = first.sourceEpoch;
    const firstReceived: HistoryRecord[] = [];
    for await (const entry of first.records(signal())) firstReceived.push(entry);
    expect(firstReceived.map(entry => entry.record.text)).toEqual(["first tail"]);
    await first.close();
    await appendFile(f.file, repeated + message("user", "second tail", "second"));

    const second = await reader.snapshot(THREAD, signal());
    try {
      expect(second.sourceEpoch).not.toBe(firstEpoch);
      const received: HistoryRecord[] = [];
      for await (const entry of second.records(signal())) received.push(entry);
      expect(received.map(entry => entry.record.text)).toEqual(["second tail"]);
    } finally {
      await second.close();
      await reader.close();
    }
  });

  it("keeps the epoch across three growing snapshots below 4 KiB", async () => {
    const f = await fixture(meta() + checkpoint("small"));
    const reader = createLocalSessionReader({root: f.root});
    const epochs: number[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        await appendFile(f.file, message("user", `tail-${i}`, `id-${i}`));
        expect((await stat(f.file)).size).toBeLessThan(4096);
        const snapshot = await reader.snapshot(THREAD, signal());
        try { epochs.push(snapshot.sourceEpoch); for await (const entry of snapshot.records(signal())) void entry; }
        finally { await snapshot.close(); }
      }
      expect(new Set(epochs).size).toBe(1);
    } finally { await reader.close(); }
  });

  it("preserves opaque checkpoint items and images separately from the tail", async () => {
    const f = await fixture(meta() + checkpoint("opaque", true) + message("user", "tail", "tail"));
    const reader = createLocalSessionReader({root: f.root});
    const snapshot = await reader.snapshot(THREAD, signal());
    try {
      expect(snapshot.checkpoint?.items).toEqual([
        {type: "message", role: "user", content: [{type: "input_text", text: "checkpoint-opaque"}]},
        {type: "compaction", encrypted_content: "encrypted-opaque"},
        {type: "message", role: "assistant", content: [{type: "input_image", image_url: "data:image/png;base64,AA=="}]}
      ]);
      expect(JSON.stringify(snapshot.checkpoint?.items)).not.toContain("must-not-be-imported");
      const received: HistoryRecord[] = [];
      for await (const entry of snapshot.records(signal())) received.push(entry);
      expect(received.map(entry => entry.record.text)).toEqual(["tail"]);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("keeps the legacy full snapshot path when no checkpoint exists", async () => {
    const f = await fixture(meta() + message("user", "legacy", "legacy"));
    const reader = createLocalSessionReader({root: f.root});
    const snapshot = await reader.snapshot(THREAD, signal());
    try {
      expect(snapshot.checkpoint).toBeUndefined();
      const received: HistoryRecord[] = [];
      for await (const entry of snapshot.records(signal())) received.push(entry);
      expect(received.map(entry => entry.record.text)).toEqual(["legacy"]);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("uses explicit outer source turns for coverage without inferring unlabelled records", async () => {
    const f=await fixture(meta()+line('event_msg',{type:'item_completed',turn_id:'outer',item:{
      type:'UserMessage',id:'outer-message',content:[{type:'input_text',text:'explicit outer turn'}]
    }}));
    const reader=createLocalSessionReader({root:f.root});const snapshot=await reader.snapshot(THREAD,signal());
    try{
      const records=[];for await(const entry of snapshot.records(signal()))records.push(entry.record);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({text:'explicit outer turn',turnId:null,sourceTurnId:'outer'});
      expect(snapshot.coverage).toEqual({complete:true,gaps:[]});
    }finally{await snapshot.close();await reader.close();}
  });
  it("does not mark known ancillary envelopes and reasoning events as missing task text",async()=>{
    const ancillary=['world_state','turn_context','token_usage_record'].map(type=>line(type,{})).join('');
    const f=await fixture(meta()+ancillary+line('event_msg',{type:'item_completed',item:{type:'Reasoning'}})+
      message('user','retained task','task'));
    const reader=createLocalSessionReader({root:f.root});const snapshot=await reader.snapshot(THREAD,signal());
    try{
      const records=[];for await(const entry of snapshot.records(signal()))records.push(entry.record);
      expect(records.map(r=>r.text)).toEqual(['retained task']);
      expect(snapshot.coverage).toEqual({complete:true,gaps:[]});
    }finally{await snapshot.close();await reader.close();}
  });
  it("retains an attribution warning for conflicting explicit inner and outer turns",async()=>{
    const f=await fixture(meta()+line('event_msg',{type:'item_completed',turn_id:'outer',item:{
      type:'UserMessage',id:'conflict',turn_id:'inner',content:[{type:'input_text',text:'conflicting turn'}]
    }}));
    const reader=createLocalSessionReader({root:f.root});const snapshot=await reader.snapshot(THREAD,signal());
    try{
      const records=[];for await(const entry of snapshot.records(signal()))records.push(entry.record);
      expect(records[0]).toMatchObject({text:'conflicting turn',sourceTurnId:null});
      expect(snapshot.coverage.complete).toBe(false);
      expect(snapshot.coverage.gaps).toContain('unattributed_record');
    }finally{await snapshot.close();await reader.close();}
  });
  it("bounds dedupe metadata while retaining text beyond the window and flags uncertainty", async () => {
    const f=await fixture(meta()+Array.from({length:4200},(_,i)=>message('assistant',`text-${i}`,`id-${i}`)).join('')+
      message('assistant','text-0','id-0'));
    const reader=createLocalSessionReader({root:f.root});
    const snapshot=await reader.snapshot(THREAD,signal());
    try {
      let count=0,last='';
      for await(const entry of snapshot.records(signal())){count++;last=entry.record.text??'';}
      expect(count).toBe(4201);
      expect(last).toBe('text-0');
      expect(snapshot.coverage).toEqual({complete:false,gaps:['deduplication_window']});
    } finally {await snapshot.close();await reader.close();}
  });
  it("keeps an earlier incomplete page authoritative after a complete terminal page", async () => {
    let page = 0;
    const snapshot = createHistorySnapshot({
      identity: "verified-source",
      sourceEpoch: 1,
      revision: 2,
      open: () => {
        page = 0;
        return {
        readPage: async () => page++ === 0 ? {
          records: [{id: "early", turnId: "turn-1", atMs: 1, kind: "user", text: "early"}],
          nextOffset: 1,
          done: false,
          coverage: {complete: false, gaps: []}
        } : {
          records: [{id: "late", turnId: "turn-1", atMs: 2, kind: "assistant", text: "late"}],
          nextOffset: 2,
          done: true,
          coverage: {complete: true, gaps: []}
        },
        close: async () => {}
        };
      },
      close: async () => {}
    });
    const records: HistoryRecord[] = [];
    for await (const entry of snapshot.records(signal())) records.push(entry);
    expect(records.map(entry => entry.record.id)).toEqual(["early", "late"]);
    expect(snapshot.coverage).toEqual({complete: false, gaps: []});
    await snapshot.close();
  });

  it("captures a fixed watermark and preserves readable history bodies", async () => {
    const largeToolOutput = "tool-result-marker:" + "x".repeat(300 * 1024);
    const initial = meta() + Array.from({length: 200}, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", `history-${index}`, `message-${index}`)
    ).join("") + message("user", "same text", "same-text-a") +
      message("user", "same text", "same-text-b") + message("user", "duplicate event", "duplicate-id") +
      message("user", "duplicate event", "duplicate-id") + toolResult(largeToolOutput);
    const f = await fixture(initial);
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;

    const snapshot = await reader.snapshot(THREAD, signal());
    const watermark = (await stat(f.file)).size;
    await appendFile(f.file, message("user", "after-watermark", "after-watermark"));
    expect(snapshot.identity).not.toContain(f.file);
    expect(snapshot.coverage.complete).toBe(false);

    const received: HistoryRecord[] = [];
    try {
      for await (const entry of snapshot.records(signal())) received.push(entry);
    } finally {
      await snapshot.close();
    }

    expect(watermark).toBeLessThan((await stat(f.file)).size);
    expect(received.map(entry => entry.ordinal)).toEqual([...received.keys()]);
    expect(received).toHaveLength(204);
    expect(received.some(entry => entry.record.text === "history-0")).toBe(true);
    expect(received.some(entry => entry.record.text === "history-199")).toBe(true);
    expect(received.some(entry => entry.record.text === "after-watermark")).toBe(false);
    expect(received.filter(entry => entry.record.text === "same text")).toHaveLength(2);
    expect(received.filter(entry => entry.record.text === "duplicate event")).toHaveLength(1);
    expect(received.find(entry => entry.record.kind === "tool_result")?.record.output).toBe(largeToolOutput);
    expect(snapshot.coverage).toEqual({complete: true, gaps: []});

    const next = await reader.snapshot(THREAD, signal());
    const nextRecords: HistoryRecord[] = [];
    try {
      for await (const entry of next.records(signal())) nextRecords.push(entry);
    } finally {
      await next.close();
      await reader.close();
    }
    expect(nextRecords.some(entry => entry.record.text === "after-watermark")).toBe(true);
  });

  it("keeps coverage non-authoritative until unsupported and partial records are examined", async () => {
    const unsupported = line("response_item", {
      type: "message", id: "attachment-message", role: "user", turn_id: "turn-1",
      content: [{type: "future_attachment", path: "must-not-be-read.txt"}]
    });
    const unattributed = line("response_item", {
      type: "message", id: "unattributed-message", role: "assistant",
      content: [{type: "output_text", text: "background record"}]
    });
    const upstreamTruncation = line("compacted", {summary: "source compacted this history"});
    const partial = JSON.stringify({timestamp: new Date().toISOString(), type: "response_item",
      payload: {type: "message", id: "partial", role: "user", turn_id: "turn-1",
        content: [{type: "input_text", text: "partial"}]}});
    const f = await fixture(meta() + message("user", "readable", "readable") + unsupported +
      unattributed + upstreamTruncation + partial);
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());

    expect(snapshot.coverage.complete).toBe(false);
    const received: HistoryRecord[] = [];
    try {
      for await (const entry of snapshot.records(signal())) received.push(entry);
    } finally {
      await snapshot.close();
      await reader.close();
    }

    expect(received.map(entry => entry.record.text)).toContain("readable");
    expect(received.map(entry => entry.record.text)).toContain("background record");
    expect(received.map(entry => entry.record.text)).not.toContain("partial");
    expect(snapshot.coverage.complete).toBe(false);
    expect(snapshot.coverage.gaps).toEqual(expect.arrayContaining([
      "unsupported_payload", "unattributed_record", "upstream_truncated", "unreadable_record"
    ]));
  });

  it("retains distinct bodies when a source identity is reused", async () => {
    const f = await fixture(meta() +
      message("user", "first body", "reused-id") +
      message("user", "changed body", "reused-id"));
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());
    try {
      const received: HistoryRecord[] = [];
      for await (const entry of snapshot.records(signal())) received.push(entry);
      expect(received.map(entry => entry.record.text)).toEqual(["first body", "changed body"]);
      expect(snapshot.coverage.complete).toBe(true);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("marks an unknown event message as unsupported instead of treating it as harmless metadata", async () => {
    const unknown = line("event_msg", {
      type: "future_content_event", id: "future-1", turn_id: "turn-1",
      content: [{type: "output_text", text: "must not be silently dropped"}]
    });
    const f = await fixture(meta() + message("user", "neighbor", "neighbor") + unknown);
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());
    try {
      const received: HistoryRecord[] = [];
      for await (const entry of snapshot.records(signal())) received.push(entry);
      expect(received.map(entry => entry.record.text)).toContain("neighbor");
      expect(snapshot.coverage.complete).toBe(false);
      expect(snapshot.coverage.gaps).toContain("unsupported_payload");
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("rejects a snapshot when the verified source is replaced before paging", async () => {
    const f = await fixture(meta() + message("user", "before replacement", "before"));
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());
    await writeFile(f.file, meta() + message("user", "after replacement", "after"), {encoding: "utf8"});

    try {
      await expect((async () => {
        for await (const _entry of snapshot.records(signal())) {
          // The source must be checked before any replaced record is exposed.
        }
      })()).rejects.toMatchObject({code: "source_identity_mismatch"});
      expect(snapshot.coverage.complete).toBe(false);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("cancels between pages and releases the snapshot source", async () => {
    const history = Array.from({length: 250}, (_, index) =>
      message("user", `cancel-${index}-${"x".repeat(32 * 1024)}`, `cancel-${index}`)
    ).join("");
    const f = await fixture(meta() + history);
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());
    const controller = new AbortController();
    let received = 0;
    try {
      await expect((async () => {
        for await (const _entry of snapshot.records(controller.signal)) {
          received += 1;
          if (received === 1) controller.abort();
        }
      })()).rejects.toMatchObject({code: "source_cancelled"});
      expect(received).toBe(1);
      expect(snapshot.coverage.complete).toBe(false);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("keeps an earlier page gap authoritative across later clean pages", async () => {
    const unsupported = line("response_item", {
      type: "message", id: "early-unsupported", role: "user", turn_id: "turn-1",
      content: [{type: "future_attachment", path: "not-read.txt"}]
    });
    const history = Array.from({length: 150}, (_, index) =>
      message("assistant", `page-${index}-${"y".repeat(40 * 1024)}`, `page-${index}`)
    ).join("");
    const f = await fixture(meta() + unsupported + history);
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());
    try {
      const received: HistoryRecord[] = [];
      for await (const entry of snapshot.records(signal())) received.push(entry);
      expect(received.length).toBe(151);
      expect(snapshot.coverage.complete).toBe(false);
      expect(snapshot.coverage.gaps).toEqual(["unsupported_payload"]);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("replays the same fixed watermark until explicitly closed", async () => {
    const f = await fixture(meta() + message("user", "before replay", "before-replay"));
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());
    const first: HistoryRecord[] = [];
    const second: HistoryRecord[] = [];
    await appendFile(f.file, message("user", "after replay", "after-replay"));
    try {
      for await (const entry of snapshot.records(signal())) first.push(entry);
      for await (const entry of snapshot.records(signal())) second.push(entry);
    } finally {
      await snapshot.close();
      await reader.close();
    }
    expect(second).toEqual(first);
    expect(second.some(entry => entry.record.text === "after replay")).toBe(false);
    await expect((async () => {
      for await (const _entry of snapshot.records(signal())) {
        // A closed snapshot must reject explicitly rather than silently yielding no records.
      }
    })()).rejects.toMatchObject({code: "source_closed"});
  });
});
