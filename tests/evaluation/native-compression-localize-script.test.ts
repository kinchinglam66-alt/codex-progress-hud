import {describe, expect, it, vi} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeComparisonFixtures} from '../../src/evaluation/native-comparison-fixture.js';
import {createPersistentReceiptJournal} from '../../src/estimation/observer-persistent-receipt.js';
import {openReleaseAccounting} from '../../src/estimation/release-accounting.js';
// @ts-expect-error TS7016: the diagnostic runner is intentionally JavaScript;
// this focused test exercises its exported offline seams without widening the
// repository-wide JavaScript declaration policy.
import * as scriptSeams from "../../scripts/diagnostics/native-compression-localize.mjs";
const {
  buildPinnedLocalizationSource,
  closeLocalizationBranch,
  createLocalizationAccountingView,
  createLocalizationBranchRegistry,
  admitLocalizationOperation,
  assertKnownLocalizationEta,
  settleLocalizationProbe,
  captureLocalizationAccounting,
  openLocalizationSnapshot,
  verifyLocalizationContext,
  localizationForkParameters,
  injectLocalizationPreservation,
} = scriptSeams;

function budgetFake() {
  return {
    settlements: [] as Array<{id: string; status: string}>,
    async reserve() { return "trial-1"; },
    async settle(id: string, status: string) { this.settlements.push({id, status}); },
  };
}

describe("native compression localization script seams", () => {
  it('places answer-free preservation guidance only in the admitted owned compression branch',async()=>{
    const calls:unknown[]=[];
    const rpc={call:async(method:string,params:unknown)=>{calls.push({method,params});return {};}};
    const options={rpc,forkId:'fork',sourceThreadId:'source',purpose:'context_compression',guidance:'Preserve task observations.',signal:new AbortController().signal};
    await injectLocalizationPreservation(options);
    expect(calls).toEqual([{method:'thread/inject_items',params:{threadId:'fork',items:[{type:'message',role:'developer',content:[{type:'input_text',text:'Preserve task observations.'}]}]}}]);
    await expect(injectLocalizationPreservation({...options,forkId:'source'})).rejects.toThrow('TRIAL_INJECTION_UNADMITTED');
    await expect(injectLocalizationPreservation({...options,purpose:'eta'})).rejects.toThrow('TRIAL_INJECTION_UNADMITTED');
    expect(calls).toHaveLength(1);
    await expect(injectLocalizationPreservation({...options,rpc:{call:async()=>({unexpected:true})}})).rejects.toThrow('TRIAL_INJECTION_ACK_INVALID');
    const controller=new AbortController();controller.abort();
    await expect(injectLocalizationPreservation({...options,signal:controller.signal})).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it('adds answer-free compaction guidance to the selected instruction layer without mutating fork input',()=>{
    const original={baseInstructions:'base',developerInstructions:'developer'};
    expect(localizationForkParameters(original,'preserve task facts','developer'))
      .toEqual({baseInstructions:'base',developerInstructions:'developer\npreserve task facts'});
    expect(localizationForkParameters(original,'preserve task facts','base-and-developer'))
      .toEqual({baseInstructions:'base\npreserve task facts',developerInstructions:'developer\npreserve task facts'});
    expect(original).toEqual({baseInstructions:'base',developerInstructions:'developer'});
    expect(localizationForkParameters(original,'diagnostic-only','base-and-developer','retain source task facts'))
      .toEqual({baseInstructions:'base\nretain source task facts',developerInstructions:'developer\ndiagnostic-only'});
    expect(()=>localizationForkParameters({developerInstructions:'developer'},'preserve','base-and-developer'))
      .toThrow('TRIAL_TRUSTED_INSTRUCTIONS_MISSING');
  });
  it('records missing context facts before fail-stop without retaining response text',()=>{
    const diagnostics:unknown[]=[];
    expect(()=>verifyLocalizationContext('FIRST secret-response-text LATEST red',['FIRST','TOOL','LATEST'],diagnostics,'B'))
      .toThrow('LOCALIZATION_CONTEXT_UNVERIFIED');
    expect(diagnostics).toEqual([{branch:'B',markerFound:[true,false,true],imageColorFound:true,verified:false}]);
    expect(JSON.stringify(diagnostics)).not.toContain('secret-response-text');
  });
  it('records a successful probe and preserves the existing red word-boundary check',()=>{
    const diagnostics:unknown[]=[];
    expect(()=>verifyLocalizationContext('FIRST TOOL LATEST RED',['FIRST','TOOL','LATEST'],diagnostics,'A')).not.toThrow();
    expect(diagnostics).toEqual([{branch:'A',markerFound:[true,true,true],imageColorFound:true,verified:true}]);
    expect(()=>verifyLocalizationContext('FIRST TOOL LATEST redacted',['FIRST','TOOL','LATEST'],diagnostics,'C'))
      .toThrow('LOCALIZATION_CONTEXT_UNVERIFIED');
    expect(diagnostics[1]).toEqual({branch:'C',markerFound:[true,true,true],imageColorFound:false,verified:false});
  });
  it('finishes cleanup with the actual append-only receipt journal and accounting view',async()=>{
    const root=await mkdtemp(join(tmpdir(),'hud-localization-journal-'));
    const ledger=await openReleaseAccounting(root,Date.now);
    try{
      const directory=join(root,'receipts'),journal=createPersistentReceiptJournal(directory);
      const events:string[]=[];
      const registry=createLocalizationBranchRegistry();
      const branch=registry.track({label:'A',ownerUuid:'88888888-8888-4888-8888-888888888888',ownerStarted:true,
        owner:{close:async()=>{events.push('owner');},status:()=>({closed:true})},journal,
        claim:{afterProcessClosed:async()=>{events.push('claim');}},
        snapshot:{close:async()=>{events.push('snapshot');}},
        resources:{release:async()=>{events.push('resources');}},
        view:ledger.forConversation('native-localization-A')});
      await expect(registry.closeAll(closeLocalizationBranch)).resolves.toEqual([]);
      expect(registry.size()).toBe(0);expect(events).toEqual(['owner','claim','snapshot','resources']);
      const records=(await readFile(join(directory,'persistent-session-receipts.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      expect(records).toHaveLength(1);expect(records[0]).toMatchObject({kind:'process_exit',processExitState:'closed'});
      expect(ledger.snapshot()).toMatchObject({starts:0,knownTokens:0,unknown:0});
    }finally{
      await ledger.close();
      if(!root.startsWith(join(tmpdir(),'hud-localization-journal-')))throw Error('UNSAFE_TEST_CLEANUP');
      await rm(root,{recursive:true,force:true});
    }
  });
  it('captures final counters before its ledger handle becomes closed',async()=>{
    let closed=false;
    const ledger={snapshot:()=>{if(closed)throw Error('database is not open');return {starts:0,knownTokens:0,unknown:0};},close:async()=>{closed=true;}};
    await expect(captureLocalizationAccounting(ledger)).resolves.toEqual({starts:0,knownTokens:0,unknown:0});
    expect(closed).toBe(true);
  });
  it('passes a valid native source identity to the actual snapshot implementation',async()=>{
    const root=await mkdtemp(join(tmpdir(),'hud-localization-snapshot-')),destinationDirectory=join(root,'copies');await mkdir(destinationDirectory);
    const sourceThreadId='88888888-8888-4888-8888-888888888888',raw=createNativeComparisonFixtures({sourceThreadId,cwd:root})[1]!;
    const branchPath=join(root,'source.jsonl');await writeFile(branchPath,raw.rollout);
    try{
      const snapshot=await openLocalizationSnapshot({branchPath,readerRoot:root,sourceThreadId,label:'A',revision:1,rollout:raw.rollout,
        signal:new AbortController().signal,destination:{sourceProfile:'codex-01534-legacy',destinationDirectory,maxSourceBytes:1024*1024,verifyDestination:async()=>{}}});
      expect(snapshot.sourceEpoch).toBe(1);expect(snapshot.byteLength).toBe(Buffer.byteLength(raw.rollout));await snapshot.close();
    }finally{if(!root.startsWith(join(tmpdir(),'hud-localization-snapshot-')))throw Error('UNSAFE_TEST_CLEANUP');await rm(root,{recursive:true,force:true});}
  });
  it("settles one accounting reservation exactly once through the bounded view", async () => {
    const budget = budgetFake();
    const underlying = {
      async reserve() { return "admission-1"; },
      async settle() {},
      async cancelBeforeDispatch() {},
      async close() {},
    };
    const branch = {slot: undefined as any, purpose: undefined as string | undefined};
    const view = createLocalizationAccountingView({view: underlying, budget, branch});

    const id = await view.reserve("ordinary", "eta");
    await view.settle(id!, {inputTokens: 1, outputTokens: 1, cachedInputTokens: 0}, "known_success");

    expect(budget.settlements).toEqual([{id: "trial-1", status: "completed"}]);
    expect(branch.slot.settled).toBe(true);
  });

  it("tracks partially allocated branches and does not emit exit evidence before confirmed close", async () => {
    const registry = createLocalizationBranchRegistry();
    const processExit = vi.fn(async () => {});
    const resourceRelease = vi.fn(async () => {});
    const branch = registry.track({
      owner: {close: vi.fn(async () => { throw new Error("close-failed"); }), status: () => ({closed: false})},
      journal: {processExit},
      resources: {release: resourceRelease},
    });

    await expect(closeLocalizationBranch(branch)).rejects.toThrow("close-failed");
    expect(processExit).not.toHaveBeenCalled();
    expect(resourceRelease).not.toHaveBeenCalled();
    expect(registry.size()).toBe(1);
  });

  it("records terminal state and settles known usage before independent evidence validation", async () => {
    const events: string[] = [];
    const branch = {
      slot: {id: "admission-1", trialId: "trial-1", settled: false},
      view: {
        async updateInvocation() { events.push("invocation:settling"); },
        async settle() { events.push("ledger:settle"); },
      },
    };
    const result = {
      terminalConfirmed: true,
      cancelled: false,
      interpretation: null,
      usage: {inputTokens: 5, outputTokens: 2, cachedInputTokens: 1},
      usageCompleteness: "single_update" as const,
    };

    await settleLocalizationProbe({
      branch,
      id: "admission-1",
      result,
      recordTerminal: async () => { events.push("receipt:terminal"); },
    });

    expect(events).toEqual(["receipt:terminal", "invocation:settling", "ledger:settle"]);
    expect(branch.slot.settled).toBe(true);
  });

  it("cancels a pre-dispatch reservation when binding or receipt admission fails", async () => {
    const budget = budgetFake();
    const cancellations: string[] = [];
    const branch = {
      label: "A",
      ownerUuid: "owner-a",
      view: undefined as any,
      journal: {async operationStarted() { throw new Error("receipt-start-failed"); }},
    };
    const underlying = {
      async reserve() { return "admission-1"; },
      async settle() {},
      async cancelBeforeDispatch(id: string) { cancellations.push(id); },
      async bindInvocation() {},
      async close() {},
    };
    branch.view = createLocalizationAccountingView({view: underlying, budget, branch});

    await expect(admitLocalizationOperation({branch, purpose: "eta", now: () => 1000}))
      .rejects.toThrow("receipt-start-failed");
    expect(cancellations).toEqual(["admission-1"]);
    expect(budget.settlements).toEqual([{id: "trial-1", status: "failed"}]);
  });

  it("does not treat a completed ETA with unknown usage as an acceptable probe", () => {
    expect(() => assertKnownLocalizationEta({terminalConfirmed: true, cancelled: false, usage: null}))
      .toThrow("LOCALIZATION_ETA_USAGE_UNVERIFIED");
  });

  it("builds C from the actual pinned envelope and event-only framing tail", () => {
    const pin = {
      serializedEnvelope: JSON.stringify({type: "compacted", payload: {replacement_history: [{type: "compaction", encrypted_content: "opaque"}]}}),
      envelopeHash: "unused",
    };
    const source = buildPinnedLocalizationSource({metadata: '{"type":"session_meta"}\n', pin, framingTail: '{"type":"event_msg","payload":{"type":"task_started"}}\n'});
    expect(source).toContain(pin.serializedEnvelope);
    expect(source).not.toContain("LOCALIZATION_PROBE_ANSWER");
    expect(() => buildPinnedLocalizationSource({metadata: '{"type":"session_meta"}\n', pin, framingTail: '{"type":"response_item"}\n'}))
      .toThrow("LOCALIZATION_SOURCE_TAIL_INVALID");
  });
});
