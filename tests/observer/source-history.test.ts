import {expect, it} from "vitest";
import {createConversationSource} from "../../src/observer/conversation-source.js";
import type {HistoryRecord, HistorySnapshot} from "../../src/observer/history-snapshot.js";
import type {ReadBatch} from "../../src/observer/conversation-record.js";
import type {NativeSourceSnapshot} from '../../src/observer/native-source-snapshot.js';
import type {NativeSourceDestination} from '../../src/observer/native-source-request.js';

const turnKey = "verified-current";
const queryBatch = (records: ReadBatch["records"]): ReadBatch => ({
  records, caughtUp: true, partialLine: false, reset: false
});

function snapshotFor(records: ReadBatch["records"], closeCount: {value: number}): HistorySnapshot {
  return {
    identity: "verified-source-token",
    sourceEpoch: 4,
    revision: 9,
    coverage: {complete: false, gaps: []},
    async *records(signal: AbortSignal): AsyncIterable<HistoryRecord> {
      if (signal.aborted) throw Error("cancelled");
      for (const [ordinal, record] of records.entries()) {
        if (signal.aborted) throw Error("cancelled");
        yield {ordinal, record};
      }
    },
    async close(): Promise<void> { closeCount.value++; }
  };
}

function makeSource(options: {
  records: ReadBatch["records"];
  snapshot?: (id: string, signal: AbortSignal) => Promise<HistorySnapshot>;
  nativeSnapshot?:(id:string,signal:AbortSignal,destination:NativeSourceDestination)=>Promise<NativeSourceSnapshot>;
}) {
  let now = 0;
  const closeCount = {value: 0};
  const source = createConversationSource({
    source: {
      read: async () => queryBatch(options.records),
      ...(options.snapshot === undefined ? {} : {snapshot: options.snapshot}),
      ...(options.nativeSnapshot===undefined?{}:{nativeSnapshot:options.nativeSnapshot}),
      remove: () => {},
      close: async () => {}
    },
    now: () => now,
    wallNow: () => now,
    turnKeyFor: (_host, id) => id === "current" ? turnKey : `verified-${id}`
  });
  return {
    source,
    attachAndRead: async () => {
      source.attach("attachment", "conversation-id", turnKey);
      now = 500;
      source.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
    },
    closeCount,
    setNow: (value: number) => { now = value; }
  };
}

it('routes native snapshots through the bound source without opening parsed history',async()=>{
 let requestedId='',destinationSeen:NativeSourceDestination|undefined,closes=0;
 const destination={destinationDirectory:'C:/owned',maxSourceBytes:10000,verifyDestination:async()=>{}};
 const f=makeSource({records:[{id:'current',turnId:'current',atMs:1,kind:'user',text:'current task'}],
  snapshot:async()=>{throw Error('PARSED_HISTORY_NOT_ALLOWED');},
  nativeSnapshot:async(id,_signal,target)=>{requestedId=id;destinationSeen=target;return {kind:'native',sourceThreadId:id,sourceTurnId:'current',sourceEpoch:1,revision:2,
    byteLength:300,path:'C:/owned/snapshot',close:async()=>{closes++;}};}});
 try{
  await f.attachAndRead();
  const result=await f.source.goals.openNativeSource!('attachment',turnKey,new AbortController().signal,destination);
  expect(result?.currentTurnId).toBe('current');expect(requestedId).toBe('conversation-id');expect(destinationSeen).toBe(destination);
  expect(result?.snapshot.kind).toBe('native');await result!.snapshot.close();expect(closes).toBe(1);
  expect(await f.source.goals.openNativeSource!('unbound',turnKey,new AbortController().signal,destination)).toBeNull();
 }finally{await f.source.close();}
});
it('rejects a native watermark from a different turn than the bound projection',async()=>{
 let closes=0;
 const f=makeSource({records:[{id:'current',turnId:'current',atMs:1,kind:'user',text:'current task'}],
  nativeSnapshot:async id=>({kind:'native',sourceThreadId:id,sourceTurnId:'future',sourceEpoch:1,revision:2,byteLength:300,
   path:'C:/owned/snapshot',close:async()=>{closes++;}})});
 try{
  await f.attachAndRead();
  await expect(f.source.goals.openNativeSource!('attachment',turnKey,new AbortController().signal,
   {destinationDirectory:'C:/owned',maxSourceBytes:10000,verifyDestination:async()=>{}})).rejects.toMatchObject({code:'SOURCE_HISTORY_BINDING_CHANGED'});
  expect(closes).toBe(1);
 }finally{await f.source.close();}
});

it("opens complete source history by verified conversation id, not the bounded projection", async () => {
  const records: ReadBatch["records"] = [
    {id: "old", turnId: "old", atMs: 1, kind: "user", text: "early source marker"},
    {id: "current", turnId: "current", atMs: 2, kind: "user", text: "current source marker"},
    {id: "runtime", turnId: "current", atMs: 3, kind: "runtime", runtime: "running"}
  ];
  let requestedId: string | undefined;
  const f = makeSource({
    records,
    snapshot: async (id) => {
      requestedId = id;
      return snapshotFor(records, f.closeCount);
    }
  });
  await f.attachAndRead();
  const opened = await f.source.goals.openHistory!("attachment", turnKey, new AbortController().signal);
  expect(requestedId).toBe("conversation-id");
  expect(opened?.currentTurnId).toBe("current");
  const history: string[] = [];
  for await (const entry of opened!.snapshot.records(new AbortController().signal)) history.push(entry.record.text ?? "");
  expect(history).toEqual(["early source marker", "current source marker", ""]);
  expect(f.source.snapshot("attachment")?.projectionOnly).toBe(true);
  await opened!.snapshot.close();
  await f.source.close();
});

it("bounds a huge first-user projection while leaving independent history readable", async () => {
  const huge = "x".repeat(300_000);
  const records: ReadBatch["records"] = [
    {id: "first", turnId: "current", atMs: 1, kind: "user", text: huge},
    {id: "runtime", turnId: "current", atMs: 2, kind: "runtime", runtime: "running"}
  ];
  const f = makeSource({
    records,
    snapshot: async () => snapshotFor(records, f.closeCount)
  });
  await f.attachAndRead();
  expect(f.source.snapshot("attachment")).toMatchObject({health: "ready", projectionOnly: true, historyComplete: false});
  expect(f.source.snapshot("attachment")!.records[0]!.text!.length).toBeLessThan(huge.length);
  const opened = await f.source.openHistory!("attachment", turnKey, new AbortController().signal);
  expect(opened).not.toBeNull();
  const history: string[] = [];
  for await (const entry of opened!.snapshot.records(new AbortController().signal)) history.push(entry.record.text ?? "");
  expect(history[0]).toBe(huge);
  await opened!.snapshot.close();
  await f.source.close();
});

it("rejects a history result whose source binding changes while opening", async () => {
  const records: ReadBatch["records"] = [
    {id: "current", turnId: "current", atMs: 1, kind: "user", text: "current"}
  ];
  let resolveSnapshot!: (snapshot: HistorySnapshot) => void;
  const f = makeSource({
    records,
    snapshot: async () => new Promise<HistorySnapshot>(resolve => { resolveSnapshot = resolve; })
  });
  await f.attachAndRead();
  const opening = f.source.openHistory!("attachment", turnKey, new AbortController().signal);
  f.source.attach("attachment", "replacement-conversation-id", "verified-next");
  resolveSnapshot(snapshotFor(records, f.closeCount));
  await expect(opening).rejects.toMatchObject({code: "SOURCE_HISTORY_BINDING_CHANGED"});
  expect(f.closeCount.value).toBe(1);
  await f.source.close();
});

it("cancels a pending history opening when the source is removed", async () => {
  const records: ReadBatch["records"] = [
    {id: "current", turnId: "current", atMs: 1, kind: "user", text: "current"}
  ];
  let observedSignal!: AbortSignal;
  let rejectSnapshot!: (error: Error) => void;
  const f = makeSource({
    records,
    snapshot: async (_id, signal) => {
      observedSignal = signal;
      signal.addEventListener("abort", () => rejectSnapshot(Error("cancelled")), {once: true});
      return new Promise<HistorySnapshot>((_resolve, reject) => { rejectSnapshot = reject; });
    }
  });
  await f.attachAndRead();
  const opening = f.source.openHistory!("attachment", turnKey, new AbortController().signal);
  f.source.remove("attachment");
  await expect(opening).rejects.toThrow("cancelled");
  expect(observedSignal.aborted).toBe(true);
  await f.source.close();
});
