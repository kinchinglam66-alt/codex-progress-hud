import {describe, expect, it} from 'vitest';
import {PassiveGoals, type GoalContextSource} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput, type HookName} from '../../src/hooks/schema.js';
import {randomUUID} from 'node:crypto';

const key = 'protected-goal-owner-test-token-1234567890';
type ExecutionEvidence=NonNullable<ReturnType<NonNullable<GoalContextSource['execution']>>>;
function fixture(source?:GoalContextSource) {
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts,source);
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
  it('binds provenance only to accepted numeric predictions, retaining old source through null refresh',()=>{
    const f=fixture(),session=f.hook('UserPromptSubmit',0),first=f.request(1000);
    const source={instanceId:randomUUID(),turnRef:'a'.repeat(64),correlationId:randomUUID(),requestId:1};
    expect(f.goals.settle(first.ticket,answer(),2000,source)).toBe(true);
    expect(f.goals.view(session,2000)?.predictionSource).toEqual(source);
    const second=f.request(3000);
    expect(JSON.stringify(second.input)).not.toContain(source.correlationId);
    expect(JSON.stringify(second.input)).not.toContain(source.turnRef);
    const other={...source,correlationId:randomUUID(),requestId:2};
    expect(f.goals.settle(second.ticket,{...answer('continue'),estimate:null},4000,other)).toBe(true);
    expect(f.goals.view(session,4000)?.predictionSource).toEqual(source);
    const copy=f.goals.view(session,4000)!.predictionSource!;copy.requestId=99;
    expect(f.goals.view(session,4000)?.predictionSource?.requestId).toBe(1);
    const stale=f.request(5000);f.hook('UserPromptSubmit',6000,'two');
    expect(f.goals.settle(stale.ticket,answer('continue'),7000,other)).toBe(false);
    expect(f.goals.view(session,7000)?.predictionSource).toBeUndefined();
  });
  it('skips full semantic scans on unrelated source revisions but observes a changed paired result',()=>{
    let revision=1,fingerprint='empty',reads=0,withResult=false;
    const user={kind:'user' as const,text:'run tests',truncated:false};
    const start={kind:'tool' as const,text:'command',truncated:false,
      event:{kind:'tool_start' as const,ordinal:1,pairOrdinal:0,atMs:1000,counterpartMissing:true}};
    const end={kind:'tool' as const,text:'done',truncated:false,
      event:{kind:'tool_result' as const,ordinal:2,pairOrdinal:0,atMs:4000}};
    const source:GoalContextSource={epoch:()=>0,
      inspect:()=>({ready:true,revision,userFingerprint:'same',pairedResultFingerprint:fingerprint,
        currentActionId:null,finalAvailable:false}),
      read:(_k,_t,q)=>{reads++;return {epoch:0,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
        input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,
          messages:withResult?[user,start,end]:[user,start]}};}};
    const f=fixture(source),session=f.hook('UserPromptSubmit',0),first=f.request(1000);
    expect(f.goals.settle(first.ticket,{...answer(),nextMilestone:{definition:'analyze test results',
      completionCriterion:'semantic',criterion:'results analyzed',operationRef:null,
      estimate:{remainingSeconds:100,errorPercent:50}}},2000)).toBe(true);
    f.goals.scheduling(session,2000);const scanned=reads;
    revision=2;f.goals.scheduling(session,3000);expect(reads).toBe(scanned);
    revision=3;fingerprint='one-paired-result';withResult=true;
    f.goals.scheduling(session,5000);expect(reads).toBe(scanned+1);
    expect(f.goals.progressDiagnostic(session)).toMatchObject({pairedResultSequence:1,
      observedEventSequence:0,milestone:{judgment:'in_progress'}});
  });
  it('exposes rejected review diagnostics while retaining numeric ETA and native runtime',()=>{
    const f=fixture(),session=f.hook('UserPromptSubmit',0),first=f.request(1000);
    const nextMilestone={definition:'stage',completionCriterion:'semantic',criterion:'checked',operationRef:null,estimate:{remainingSeconds:100,errorPercent:50}};
    expect(f.goals.settle(first.ticket,{...answer(),nextMilestone},2000)).toBe(true);
    const second=f.request(3000),milestoneId=second.input.progressState!.milestone!.id;
    expect(f.goals.settle(second.ticket,{...answer('continue'),estimate:{remainingSeconds:240,errorPercent:50},
      progressReview:{milestoneId,assessment:'inferred_complete',evidenceRefs:['te_'+'a'.repeat(32)],changedAssumptions:[]}},4000)).toBe(true);
    const view=f.goals.view(session,4000)!;
    expect(view.runtime).toBe('running');expect(view.prediction?.remainingSeconds).toBe(240);
    expect(view.progressState?.reviewApplication?.outcome).toBe('evidence_not_in_scope');
    expect(view.progressState?.milestone?.judgment).toBe('in_progress');
    view.progressState!.reviewApplication!.outcome='applied';
    expect(f.goals.view(session,4000)?.progressState?.reviewApplication?.outcome).toBe('evidence_not_in_scope');
  });
  it('binds conditions to their accepted prediction, retains them on null refresh and drops them on a new turn',()=>{
    const f=fixture(),session=f.hook('UserPromptSubmit',0),first=f.request(1000);
    const estimate={remainingSeconds:10,errorPercent:100};
    const response={...answer(),estimate,estimateConditions:{selectedPath:'report_blocker',reportBlocker:estimate,continueWork:null,milestonePath:'unknown'}};
    expect(f.goals.settle(first.ticket,response,2000)).toBe(true);
    expect(f.goals.view(session,2000)!.estimateCondition).toMatchObject({displayPath:'report_blocker',issue:'conditional'});
    const second=f.request(3000);expect(f.goals.settle(second.ticket,{...answer('continue'),estimate:null},4000)).toBe(true);
    expect(f.goals.view(session,4000)!.estimateCondition?.displayPath).toBe('report_blocker');
    f.hook('UserPromptSubmit',5000,'two');expect(f.goals.view(session,5000)?.estimateCondition).toBeUndefined();
  });
  it.each([{endAt:120000,expected:29},{endAt:50000,expected:null}])('maps milestone completion after pause only within the current segment: %j',({endAt,expected})=>{
    let revision=1;
    const user={kind:'user' as const,text:'run tests',truncated:false,event:{kind:'user' as const,ordinal:0,atMs:0}};
    const start={kind:'tool' as const,text:'command',truncated:false,event:{kind:'tool_start' as const,ordinal:1,pairOrdinal:0,atMs:500}};
    const end={kind:'tool' as const,text:'done',truncated:false,event:{kind:'tool_result' as const,ordinal:2,pairOrdinal:0,atMs:endAt}};
    const source:GoalContextSource={epoch:()=>0,read:(_k,_t,q)=>({epoch:0,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
      input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,messages:revision===1?[user,start]:[user,start,end]}})};
    const f=fixture(source),session=f.hook('UserPromptSubmit',0),first=f.request(1000);
    const operationRef=first.input.progressState!.operations[0]!.operationRef;
    expect(f.goals.settle(first.ticket,{...answer(),nextMilestone:{definition:'end',completionCriterion:'operation_end',criterion:'command ends',operationRef,estimate:{remainingSeconds:100,errorPercent:50}}},2000)).toBe(true);
    const turn=f.contexts.read(session)!.entries[0]!.turnKey;
    f.goals.runtime(session,turn,'paused',10000);f.goals.runtime(session,turn,'running',100000);
    revision=2;
    const second=f.request(121000);
    expect(second.input.progressState?.lastObservedMilestone?.actualRemainingActiveSeconds).toBe(expected);
    expect(second.input.progressState?.lastObservedMilestone?.forecastErrorSeconds).toBe(expected===null?null:100-expected);
    expect(f.goals.progressDiagnostic(session)?.lastObservedMilestone?.forecastErrorSeconds).toBe(expected===null?null:100-expected);
    expect(second.input.progressState?.lastObservedMilestone?.operationWallSeconds).toBe((endAt-500)/1000);
    expect(second.input.activeSeconds).toBe(31);
  });
  it('keeps milestone state across pause/resume, transfers it explicitly and resets on a new turn',()=>{
    const f=fixture(),session=f.hook('UserPromptSubmit',0),first=f.request(1000);
    const nextMilestone={definition:'检查测试',completionCriterion:'semantic',criterion:'结果已分析',operationRef:null,estimate:{remainingSeconds:100,errorPercent:50}};
    expect(f.goals.settle(first.ticket,{...answer(),nextMilestone,progressReview:null},2000)).toBe(true);
    const before=f.goals.view(session,2000)!.progressState!.milestone!;
    const turn=f.contexts.read(session)!.entries[0]!.turnKey;
    f.goals.runtime(session,turn,'paused',10000);f.goals.runtime(session,turn,'running',100000);
    const second=f.request(101000);expect(second.input.progressState?.milestone?.id).toBe(before.id);
    expect(second.input.activeSeconds).toBe(11);expect(second.input.progressState?.milestone?.prediction?.observedActiveSeconds).toBe(1);
    f.goals.settle(second.ticket,answer('continue'),101000);
    f.hook('UserPromptSubmit',102000,'two');expect(f.goals.view(session,102000)?.progressState).toBeUndefined();
    const third=f.request(103000);expect(third.input.progressState?.milestone).toBeNull();
  });
  it('rejects old milestone results when native completion appears only at settlement',()=>{
    let revision=1;
    const user={kind:'user' as const,text:'run tests',truncated:false,event:{kind:'user' as const,ordinal:0,atMs:0}};
    const start={kind:'tool' as const,text:'PRIVATE command',truncated:false,event:{kind:'tool_start' as const,ordinal:7,pairOrdinal:0,atMs:1000}};
    const end={kind:'tool' as const,text:'failed tests',truncated:false,event:{kind:'tool_result' as const,ordinal:9,pairOrdinal:0,atMs:4000}};
    const source:GoalContextSource={epoch:()=>0,read:(_k,_t,q)=>({epoch:0,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
      input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,messages:revision===1?[user,start]:[user,start,end]}})};
    const f=fixture(source),session=f.hook('UserPromptSubmit',0),first=f.request(1000);
    const operationRef=first.input.progressState!.operations[0]!.operationRef;
    const nextMilestone={definition:'tests end',completionCriterion:'operation_end',criterion:'command ends',operationRef,estimate:{remainingSeconds:100,errorPercent:50}};
    expect(f.goals.settle(first.ticket,{...answer(),nextMilestone},2000)).toBe(true);
    const second=f.request(3000);revision=2;
    expect(f.goals.settle(second.ticket,{...answer('continue'),nextMilestone},5000)).toBe(false);
    expect(f.goals.rejectionReason(second.ticket)).toBe('critical_event_after_snapshot');
    expect(f.goals.view(session,5000)?.progressState?.milestone?.judgment).toBe('observed_complete');
    expect(JSON.stringify(f.goals.view(session,5000))).not.toContain('PRIVATE command');
  });
  it('accepts an aged numeric ETA without installing its first semantic milestone',()=>{
    let revision=1;
    const source:GoalContextSource={epoch:()=>0,read:(_k,_t,q)=>({epoch:0,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
      input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,messages:[{kind:'user',text:'inspect and repair',truncated:false}]}})};
    const f=fixture(source),session=f.hook('UserPromptSubmit',0),request=f.request(1000);
    revision=2;
    expect(f.goals.settle(request.ticket,{...answer(),nextMilestone:{definition:'inspection findings',completionCriterion:'semantic',criterion:'findings available',operationRef:null,estimate:{remainingSeconds:100,errorPercent:30}}},3000)).toBe(true);
    expect(f.goals.view(session,3000)?.prediction).not.toBeNull();
    expect(f.goals.view(session,3000)?.progressState?.milestone).toBeNull();
    expect(f.goals.progressDiagnostic(session)?.milestoneApplication).toBeUndefined();
    expect(f.goals.progressSettlement(request.ticket)).toEqual({responseKind:'provided',outcome:'aged_numeric_only'});
  });
  it.each([undefined,null])('distinguishes absent milestone inputs without reusing a prior ticket diagnostic: %s',nextMilestone=>{
    const f=fixture();f.hook('UserPromptSubmit',0);const request=f.request(1000);
    expect(f.goals.progressSettlement(request.ticket)).toBeUndefined();
    expect(f.goals.settle(request.ticket,{...answer(),nextMilestone},2000)).toBe(true);
    expect(f.goals.progressSettlement(request.ticket)).toEqual({responseKind:nextMilestone===null?'explicit_null':'omitted',outcome:'progress_applied'});
    const next=f.request(3000);
    expect(f.goals.progressSettlement(next.ticket)).toBeUndefined();
    expect(f.goals.settle(next.ticket,null,4000)).toBe(false);
    expect(f.goals.progressSettlement(next.ticket)).toBeUndefined();
  });
  it.each(['valid','null','expired'])('carries an aged milestone into the next natural request and reviews it historically without completing the task (numeric=%s)',numeric=>{
    let revision=1;
    const user={kind:'user' as const,text:'inspect and repair',truncated:false,event:{kind:'user' as const,ordinal:0,atMs:0}};
    const start={kind:'tool' as const,text:'inspect',truncated:false,event:{kind:'tool_start' as const,ordinal:1,pairOrdinal:1,atMs:1000}};
    const end={kind:'tool' as const,text:'found issue',truncated:false,event:{kind:'tool_result' as const,ordinal:2,pairOrdinal:1,atMs:3000}};
    const source:GoalContextSource={epoch:()=>0,read:(_k,_t,q)=>({epoch:0,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
      input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,messages:revision===1?[user,start]:[user,start,end]}})};
    const f=fixture(source),session=f.hook('UserPromptSubmit',0),first=f.request(1000);revision=2;
    expect(f.goals.settle(first.ticket,{...answer(),nextMilestone:{definition:'inspection findings',completionCriterion:'semantic',criterion:'finding',operationRef:null,estimate:{remainingSeconds:100,errorPercent:30}}},4000)).toBe(true);
    expect(f.goals.pendingMilestoneDecision(first.ticket)).toMatchObject({retained:true,reviewOutcome:'not_provided',retainedCandidate:{observedActiveSeconds:1,sourceRevision:1,estimate:{remainingSeconds:100,errorPercent:30}}});
    const second=f.request(5000),candidate=second.input.pendingMilestone!;
    expect(candidate.observedActiveSeconds).toBe(1);expect(candidate.sourceRevision).toBe(1);
    expect(second.input.progressState?.milestone).toBeNull();expect(second.input.progressState?.observedEventSequence).toBe(0);
    const evidenceRef=second.input.progressState!.operations.find(o=>o.state==='ended')!.evidenceRef;
    revision=3;
    const previous=f.goals.view(session,5000)!.prediction;
    expect(f.goals.settle(second.ticket,{...answer('continue'),estimate:numeric==='null'?null:numeric==='expired'?{remainingSeconds:1,errorPercent:30}:answer().estimate,pendingMilestoneReview:{candidateId:candidate.id,assessment:'inferred_complete',evidenceRefs:[evidenceRef]}},6000)).toBe(numeric==='valid');
    if(numeric==='expired'){
      expect(f.goals.rejectionReason(second.ticket)).toBe('estimate_expired_on_arrival');
      expect(f.goals.view(session,6000)!.prediction).toEqual(previous);
      expect(f.goals.progressSettlement(second.ticket)).toBeUndefined();
    }
    expect(f.goals.pendingMilestoneDecision(second.ticket)).toMatchObject({retained:false,reviewOutcome:'reviewed',assessment:'inferred_complete',snapshotActiveSeconds:5,sourceRevision:2});
    expect(f.goals.view(session,6000)?.runtime).toBe('running');expect(f.goals.view(session,6000)?.progressState?.milestone).toBeNull();
    expect(f.request(7000).input.pendingMilestone).toBeUndefined();
  });
  it.each(['valid','bad_evidence','wrong_candidate','no_candidate','new_turn','source_reset','paused','native_complete','model_complete','duplicate'])('fences expired historical review: %s',mode=>{
    let revision=1,epoch=0;
    let execution:ExecutionEvidence={state:'running',identity:'initial'};
    const user={kind:'user' as const,text:'inspect',truncated:false,event:{kind:'user' as const,ordinal:0,atMs:0}};
    const start={kind:'tool' as const,text:'test',truncated:false,event:{kind:'tool_start' as const,ordinal:1,pairOrdinal:1,atMs:1000}};
    const end={kind:'tool' as const,text:'result',truncated:false,event:{kind:'tool_result' as const,ordinal:2,pairOrdinal:1,atMs:2500}};
    const source:GoalContextSource={epoch:()=>epoch,execution:()=>execution,read:(_k,_t,q)=>({epoch,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
      input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,messages:revision===1?[user,start]:[user,start,end]}})};
    const f=fixture(source),session=f.hook('UserPromptSubmit',0),first=f.request(1000);revision=2;
    f.goals.settle(first.ticket,{...answer(),nextMilestone:mode==='no_candidate'?null:{definition:'inspect',completionCriterion:'semantic',criterion:'result',operationRef:null,estimate:null}},3000);
    const second=f.request(4000),candidateId=second.input.pendingMilestone?.id??'pc_'+'a'.repeat(32);
    const evidence=second.input.progressState!.operations.find(o=>o.state==='ended')!.evidenceRef;
    const response={...answer('continue'),status:mode==='model_complete'?'completed':'running',estimate:{remainingSeconds:1,errorPercent:30},
      nextMilestone:{definition:'must not retain',completionCriterion:'semantic',criterion:'new',operationRef:null,estimate:null},
      pendingMilestoneReview:{candidateId:mode==='wrong_candidate'?'pc_'+'b'.repeat(32):candidateId,assessment:'inferred_complete',evidenceRefs:[mode==='bad_evidence'?'ev_'+'c'.repeat(32):evidence]}};
    if(mode==='new_turn')f.hook('UserPromptSubmit',4500,'two');
    if(mode==='source_reset')epoch++;
    if(mode==='paused')f.goals.runtime(session,f.contexts.read(session)!.entries[0]!.turnKey,'paused',5500);
    if(mode==='native_complete'){execution={state:'waiting',outcome:'completed',boundaryMs:5500,identity:'done'};f.goals.reconcileSource(session,5500);}
    const before=f.goals.view(session,6000)!;
    expect(f.goals.settle(second.ticket,response,6000)).toBe(false);
    const decision=f.goals.pendingMilestoneDecision(second.ticket);
    if(['valid','duplicate'].includes(mode))expect(decision).toMatchObject({retained:false,reviewOutcome:'reviewed',candidateId,snapshotActiveSeconds:4});
    else if(mode==='bad_evidence')expect(decision).toMatchObject({retained:false,reviewOutcome:'evidence_not_in_snapshot'});
    else if(mode==='wrong_candidate')expect(decision).toMatchObject({retained:false,reviewOutcome:'candidate_mismatch'});
    else expect(decision).toBeUndefined();
    const after=f.goals.view(session,6000)!;
    expect(after.prediction).toEqual(before.prediction);expect(after.runtime).toBe(before.runtime);expect(after.status).toBe(before.status);
    expect(f.goals.progressSettlement(second.ticket)).toBeUndefined();
    if(mode==='duplicate'){expect(f.goals.settle(second.ticket,response,6100)).toBe(false);expect(f.goals.pendingMilestoneDecision(second.ticket)).toEqual(decision);}
    if(['valid','duplicate','bad_evidence','wrong_candidate','no_candidate','model_complete'].includes(mode)){
      const next=f.request(7000).input.pendingMilestone;
      expect(next?.forecast.definition).not.toBe('must not retain');
      if(['bad_evidence','wrong_candidate','model_complete'].includes(mode))expect(next?.id).toBe(candidateId);
      else expect(next).toBeUndefined();
    }
  });
  it('preserves historical forecast identity and anchor across same-turn pause/resume',()=>{
    let revision=1;
    const source:GoalContextSource={epoch:()=>0,read:(_k,_t,q)=>({epoch:0,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
      input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,messages:[{kind:'user',text:'inspect',truncated:false}]}})};
    const f=fixture(source),session=f.hook('UserPromptSubmit',0),first=f.request(1000);revision=2;
    f.goals.settle(first.ticket,{...answer(),nextMilestone:{definition:'finding',completionCriterion:'semantic',criterion:'finding',operationRef:null,estimate:null}},2000);
    const id=f.goals.pendingMilestoneDecision(first.ticket)?.retainedCandidate?.id;
    const turn=f.contexts.read(session)!.entries[0]!.turnKey;
    f.goals.runtime(session,turn,'paused',3000);f.goals.runtime(session,turn,'running',103000);
    const request=f.request(104000);
    expect(request.input.pendingMilestone).toMatchObject({id,observedActiveSeconds:1,sourceRevision:1});
    expect(request.input.activeSeconds).toBe(4);expect(request.input.progressState?.milestone).toBeNull();
  });
  it.each(['new_turn','source_reset','native_completion'])('clears a pending historical candidate on %s',boundary=>{
    let revision=1,epoch=0;
    let evidence:ExecutionEvidence={state:'running',identity:'initial'};
    const source:GoalContextSource={epoch:()=>epoch,execution:()=>evidence,read:(_k,_t,q)=>({epoch,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
      input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,messages:[{kind:'user',text:'inspect',truncated:false}]}})};
    const f=fixture(source);const session=f.hook('UserPromptSubmit',0);const first=f.request(1000);revision=2;
    f.goals.settle(first.ticket,{...answer(),nextMilestone:{definition:'finding',completionCriterion:'semantic',criterion:'finding',operationRef:null,estimate:null}},2000);
    expect(f.goals.pendingMilestoneDecision(first.ticket)?.retained).toBe(true);
    if(boundary==='source_reset')epoch++;
    else if(boundary==='native_completion'){
      evidence={state:'waiting',outcome:'completed',boundaryMs:3000,identity:'completed'};
      f.goals.reconcileSource(session,3000);
      expect(f.goals.view(session,3000)?.status).toBe('completed');
      evidence={state:'running',boundaryMs:3500,identity:'late-running'};
      f.goals.reconcileSource(session,3500);
    }else f.hook('UserPromptSubmit',3000,'two');
    expect(f.request(4000).input.pendingMilestone).toBeUndefined();
  });
  it.each(['null','unknown'])('does not invent a historical receipt without a candidate for aged %s',kind=>{
    let revision=1;
    const source:GoalContextSource={epoch:()=>0,read:(_k,_t,q)=>({epoch:0,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
      input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,messages:[{kind:'user',text:'inspect',truncated:false}]}})};
    const f=fixture(source);f.hook('UserPromptSubmit',0);const request=f.request(1000);revision=2;
    expect(f.goals.settle(request.ticket,{...answer(),estimate:null,...(kind==='unknown'?{relation:'unknown'}:{})},2000)).toBe(false);
    expect(f.goals.pendingMilestoneDecision(request.ticket)).toBeUndefined();
  });
  it('does not retain a rejected or duplicate late candidate across turns',()=>{
    let revision=1;
    const source:GoalContextSource={epoch:()=>0,read:(_k,_t,q)=>({epoch:0,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
      input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,messages:[{kind:'user',text:'inspect',truncated:false}]}})};
    const f=fixture(source);f.hook('UserPromptSubmit',0);const first=f.request(1000);revision=2;
    const result={...answer(),nextMilestone:{definition:'finding',completionCriterion:'semantic',criterion:'finding',operationRef:null,estimate:null}};
    f.hook('UserPromptSubmit',2000,'two');
    expect(f.goals.settle(first.ticket,result,3000)).toBe(false);
    expect(f.goals.settle(first.ticket,result,3100)).toBe(false);
    expect(f.goals.pendingMilestoneDecision(first.ticket)).toBeUndefined();
    expect(f.request(4000).input.pendingMilestone).toBeUndefined();
  });
  it('consumes locally proven milestone evidence at an exact preparation snapshot',()=>{
    let revision=1;
    const source:GoalContextSource={epoch:()=>0,read:(_k,_t,q)=>({epoch:0,revision,userFingerprint:'same',currentActionId:null,finalAvailable:false,
      input:{goalSummary:q.goalSummary,activeSeconds:q.activeSeconds,runtime:q.runtime,truncated:false,messages:[{kind:'user',text:'run tests',truncated:false}]}})};
    const f=fixture(source),session=f.hook('UserPromptSubmit',0);const request=f.request(1000);revision=2;
    expect(f.goals.progressAtSnapshot(request.ticket,request.input,1,2000)).toBe(request.input);
    const updated=f.goals.progressAtSnapshot(request.ticket,request.input,2,2000);expect(updated).not.toBe(request.input);
    expect(updated.activeSeconds).toBe(2);
    expect(f.goals.settle(request.ticket,{...answer(),nextMilestone:{definition:'stage',completionCriterion:'semantic',criterion:'observed',operationRef:null,estimate:{remainingSeconds:200,errorPercent:30}}},3000)).toBe(true);
    const view=f.goals.view(session,3000);
    expect(view?.prediction?.observedActiveSeconds).toBe(2);
    expect(view?.progressState?.milestone?.prediction?.observedActiveSeconds).toBe(2);
  });
  it('rejects a numeric estimate that expired during preparation or inference without moving its anchor',()=>{
    const f=fixture(),session=f.hook('UserPromptSubmit',0),request=f.request(1000);
    const estimate={...answer(),estimate:{remainingSeconds:60,errorPercent:30}};
    expect(f.goals.settle(request.ticket,estimate,71000)).toBe(false);
    expect(f.goals.rejectionReason(request.ticket)).toBe('estimate_expired_on_arrival');
    expect(f.goals.view(session,71000)!.prediction).toBeNull();
    expect(f.goals.view(session,71000)!.progressFloor??0).toBeLessThan(99);
  });
  it('does not count revision or action-only bookkeeping as new recovery content',()=>{
    let revision=1,currentActionId:string|null='action',contentFingerprint='content-one';
    const source:GoalContextSource={health:()=> 'ready',epoch:()=>0,
      inspect:()=>({ready:true,revision,currentActionId,contentFingerprint,finalAvailable:false}),
      read:()=>null};
    const f=fixture(source),session=f.hook('UserPromptSubmit',0);
    const initial=f.goals.scheduling(session,0)!.contentIdentity;expect(initial).toBeDefined();
    revision++;currentActionId=null;
    expect(f.goals.scheduling(session,1000)!.contentIdentity).toBe(initial);
    contentFingerprint='content-two';revision++;
    expect(f.goals.scheduling(session,2000)!.contentIdentity).not.toBe(initial);
  });
  it.each(['continue','unknown'] as const)('keeps the prior countdown during a same-turn %s refresh without a new estimate',relation=>{
    const f=fixture(),session=f.hook('UserPromptSubmit',0);
    expect(f.goals.settle(f.request(15000).ticket,answer(),16000)).toBe(true);
    const previous=f.goals.view(session,16000)!.prediction!;
    const refresh=f.request(30000);
    expect(f.goals.view(session,35000)!.prediction).toEqual(previous);
    expect(f.goals.settle(refresh.ticket,{...answer('continue'),relation,status:relation==='unknown'?'unknown':'running',summary:null,estimate:null},40000)).toBe(true);
    const later=f.goals.view(session,50000)!;
    expect(later.prediction).toEqual(previous);
    expect(later.activeSeconds).toBeGreaterThan(f.goals.view(session,40000)!.prediction!.observedActiveSeconds);
  });
  it('freezes at the last authenticated boundary when an initial source failure has no trusted timestamp',()=>{
    const f=fixture({epoch:()=>1,read:()=>null,execution:()=>({state:'unknown',identity:'initial-partial'})});
    const session=f.hook('UserPromptSubmit',0);
    f.goals.reconcileSource(session,500);
    expect(f.goals.view(session,5000)).toMatchObject({runtime:'waiting',runtimeUncertain:true,timingUncertain:true,activeSeconds:0});
  });
  it('marks an explicitly completed persisted turn complete without observer inference',()=>{
    const f=fixture({epoch:()=>1,read:()=>null,execution:()=>({state:'waiting',outcome:'completed',boundaryMs:1000,identity:'completed'}) as never});
    const session=f.hook('UserPromptSubmit',0);
    f.goals.reconcileSource(session,3000);
    expect(f.goals.view(session,4000)).toMatchObject({status:'completed',runtime:'waiting',activeSeconds:1});
    expect(f.goals.request(session,4000)).toBeNull();
  });
  it.each(['paused','stopped'] as const)('does not let an in-flight source result undo manual %s', state=>{
    let attempts=0;
    const f=fixture({epoch:()=>1,read:()=>null,
      execution:()=>({state:'running',identity:'next-source'}),
      takeover:()=>{attempts++;return {turnKey:'turn-two',startedAtMs:2000,identity:'next-source'};}});
    const session=f.hook('UserPromptSubmit',0);
    const turnKey=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'one'},0,key).envelope.turnKey!;
    f.goals.runtime(session,turnKey,state,1000);
    expect(f.goals.reconcileSource(session,3000)).toBeNull();
    expect(attempts).toBe(0);
    expect(f.goals.currentTurnKey(session)).toBe(turnKey);
    expect(f.goals.view(session,4000)).toMatchObject({runtime:state,activeSeconds:1});
  });
  it.each(['failed','interrupted'] as const)('allows verified next-turn takeover after a %s prior turn', state=>{
    let takeover:null|{turnKey:string;startedAtMs:number;identity:string} = null;
    const f=fixture({epoch:()=>1,read:()=>null,execution:()=>({state,identity:`${state}-source`}),takeover:()=>takeover});
    const session=f.hook('UserPromptSubmit',0);
    const turnKey=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'one'},0,key).envelope.turnKey!;
    f.goals.runtime(session,turnKey,state,1000);
    takeover={turnKey:'turn-two',startedAtMs:2000,identity:'next-source'};
    expect(f.goals.reconcileSource(session,3000)).toMatchObject({previousTurnKey:turnKey,turnKey:'turn-two'});
    expect(f.goals.view(session,4000)).toMatchObject({runtime:'running',status:'unknown',activeSeconds:1});
  });
  it('reconciles missing Stop from source without allowing stale source activity to undo a hook Stop', () => {
    let evidence:ExecutionEvidence={state:'waiting',boundaryMs:1000,identity:'final'};
    const f=fixture({epoch:()=>1,read:()=>null,execution:()=>evidence});
    const session=f.hook('UserPromptSubmit',0);
    f.goals.reconcileSource(session,3000);
    expect(f.goals.view(session,4000)).toMatchObject({runtime:'waiting',activeSeconds:1});
    f.hook('PostToolUse',4500);
    expect(f.goals.view(session,4500)).toMatchObject({runtime:'waiting',activeSeconds:1});
    evidence={state:'running',boundaryMs:5000,identity:'resume'};
    f.goals.reconcileSource(session,5000);
    expect(f.goals.view(session,6000)).toMatchObject({runtime:'running',activeSeconds:2});
    f.hook('Stop',6000);
    evidence={state:'running',boundaryMs:7000,identity:'late'};
    f.goals.reconcileSource(session,7000);
    expect(f.goals.view(session,8000)).toMatchObject({runtime:'waiting',activeSeconds:2});
    evidence={state:'waiting',outcome:'completed',boundaryMs:7500,identity:'explicit-complete'};
    f.goals.reconcileSource(session,8000);
    expect(f.goals.view(session,9000)).toMatchObject({status:'completed',runtime:'waiting',activeSeconds:2});
  });
  it('freezes uncertain timing but never times out a silent running action', () => {
    let evidence:ExecutionEvidence={state:'running',boundaryMs:0,identity:'long-tool'};
    const f=fixture({epoch:()=>1,read:()=>null,execution:()=>evidence});
    const session=f.hook('UserPromptSubmit',0);
    f.goals.reconcileSource(session,1000);
    f.goals.reconcileSource(session,900000);
    expect(f.goals.view(session,900000)).toMatchObject({runtime:'running',activeSeconds:900});
    evidence={state:'unknown',boundaryMs:900000,identity:'read-failure'};
    f.goals.reconcileSource(session,901000);
    expect(f.goals.view(session,905000)).toMatchObject({runtime:'waiting',timingUncertain:true,activeSeconds:900});
    evidence={state:'running',boundaryMs:0,identity:'long-tool'};
    f.goals.reconcileSource(session,910000);
    expect(f.goals.view(session,911000)).toMatchObject({runtime:'running',timingUncertain:true,activeSeconds:901});
  });
  it('does not restart a stopped turn on late tool results or a repeated prompt', () => {
    const f=fixture(),session=f.hook('UserPromptSubmit',0);
    const stale=f.request(500);
    f.hook('Stop',1000);
    f.hook('PostToolUse',2000);
    f.hook('UserPromptSubmit',3000);
    expect(f.goals.view(session,5000)).toMatchObject({runtime:'waiting',activeSeconds:1});
    expect(f.goals.settle(stale.ticket,answer(),5000)).toBe(false);
    f.hook('UserPromptSubmit',6000,'two');
    expect(f.goals.view(session,7000)).toMatchObject({runtime:'running',activeSeconds:1});
  });
  it('increments the source generation when a new turn starts', () => {
    const f=fixture(),session=f.hook('UserPromptSubmit',0,'one');
    expect(f.goals.view(session,0)?.generation).toBe(0);
    f.hook('Stop',1000,'one');
    f.hook('UserPromptSubmit',2000,'two');
    expect(f.goals.view(session,2000)).toMatchObject({generation:1,runtime:'running',activeSeconds:0});
  });
  it('keeps stop fences conversation-local and permits an explicit verified resume',()=>{
    const f=fixture(),a=f.hook('UserPromptSubmit',0,'one',true,'a');
    const b=f.hook('UserPromptSubmit',0,'one',true,'b');
    f.hook('Stop',1000,'one',true,'a');
    f.hook('PostToolUse',2000,'one',true,'b');
    expect(f.goals.view(a,3000)).toMatchObject({runtime:'waiting',activeSeconds:1});
    expect(f.goals.view(b,3000)).toMatchObject({runtime:'running',activeSeconds:3});
    const turn=normalizeHookInput('UserPromptSubmit',{session_id:'a',turn_id:'one'},0,key).envelope.turnKey!;
    f.goals.runtime(a,turn,'running',4000);
    expect(f.goals.view(a,5000)).toMatchObject({runtime:'running',activeSeconds:2});
  });
  it('projects only the accepted bounded change reason and clears absent reasons',()=>{
    const f=fixture(),session=f.hook('UserPromptSubmit',0);
    const withWork={...answer(),work:{composition:'serial',changeReason:'failure',parts:[
      {workClass:'other',unit:'unknown',remainingUnits:null,priorSeconds:3600}]}};
    expect(f.goals.settle(f.request(15000).ticket,withWork,16000)).toBe(true);
    expect(f.goals.view(session,16000)?.changeReason).toBe('failure');
    expect(JSON.stringify(f.goals.view(session,16000))).not.toContain('parts');
    expect(f.goals.settle(f.request(17000).ticket,answer('continue'),18000)).toBe(true);
    expect(f.goals.view(session,18000)?.changeReason).toBeUndefined();
  });
  it('does not project work metadata from stale answers into a new goal',()=>{
    const f=fixture(),session=f.hook('UserPromptSubmit',0);
    const pending=f.request(15000);
    f.hook('UserPromptSubmit',16000,'second');
    const stale={...answer(),work:{composition:'serial',changeReason:'scope_change',parts:[
      {workClass:'other',unit:'unknown',remainingUnits:null,priorSeconds:3600}]}};
    expect(f.goals.settle(pending.ticket,stale,17000)).toBe(false);
    expect(f.goals.view(session,17000)?.changeReason).toBeUndefined();
    expect(f.goals.settle(f.request(18000).ticket,answer(),19000)).toBe(true);
    expect(f.goals.view(session,19000)?.changeReason).toBeUndefined();
  });
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

  it('resets active work and summary scope at every new turn', () => {
    const f = fixture(); const session = f.hook('UserPromptSubmit', 0);
    f.hook('PostToolUse', 1000);
    expect(f.goals.settle(f.request(5000).ticket, answer(), 5000)).toBe(true);
    f.hook('Stop', 10000);
    expect(f.goals.view(session, 25000)?.activeSeconds).toBe(10);
    f.hook('UserPromptSubmit', 30000, 'two');
    const continuing = f.request(35000);
    expect(continuing.input.goalSummary).toBeNull();
    expect(f.goals.settle(continuing.ticket, answer('continue'), 35000)).toBe(true);
    expect(f.goals.view(session, 35000)).toMatchObject({generation: 2, activeSeconds: 5});
    f.hook('UserPromptSubmit', 40000, 'three');
    expect(f.goals.settle(f.request(45000).ticket, {...answer(), summary: 'NEW goal'}, 45000)).toBe(true);
    expect(f.goals.view(session, 45000)).toMatchObject({generation: 3, activeSeconds: 5});
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
    expect(f.goals.settle(f.request(1000).ticket, {...answer(), estimate: {remainingSeconds: 0, errorPercent: 50}}, 1000)).toBe(false);
    expect(f.goals.view(session, 2000)).toMatchObject({runtime:'running',prediction:null});
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

  it('reports concrete rejection gates while preserving the boolean settlement contract', () => {
    const malformed = fixture();
    const malformedSession = malformed.hook('UserPromptSubmit', 0);
    const malformedTicket = malformed.request(1000).ticket;
    expect(malformed.goals.settle(malformedTicket, {relation: 'replace'}, 1000)).toBe(false);
    expect(malformed.goals.rejectionReason(malformedTicket)).toBe('schema_invalid');
    expect(malformed.goals.view(malformedSession, 1000)).toMatchObject({estimateRevision: 0, prediction: null});

    let sourceEpoch = 0;
    const source: GoalContextSource = {
      epoch: () => sourceEpoch,
      read: (_key, _turnKey, query) => ({epoch: sourceEpoch, revision: 1, currentActionId: 'action',
        finalAvailable: false, input: {goalSummary: null, activeSeconds: query.activeSeconds, runtime: query.runtime,
          messages: [{kind: 'user', text: 'source task', truncated: false}], truncated: false}})
    };
    const changed = fixture(source);
    const changedSession = changed.hook('UserPromptSubmit', 0);
    const changedTicket = changed.request(1000).ticket;
    sourceEpoch = 1;
    expect(changed.goals.settle(changedTicket, answer(), 1000)).toBe(false);
    expect(changed.goals.rejectionReason(changedTicket)).toBe('source_epoch_changed');
    expect(changed.goals.view(changedSession, 1000)).toMatchObject({estimateRevision: 0, prediction: null});

    const terminal = fixture();
    const terminalSession = terminal.hook('UserPromptSubmit', 0);
    const terminalTicket = terminal.request(1000).ticket;
    terminal.goals.runtime(terminalSession, terminal.goals.currentTurnKey(terminalSession)!, 'failed', 1000);
    expect(terminal.goals.settle(terminalTicket, answer(), 1000)).toBe(false);
    expect(terminal.goals.rejectionReason(terminalTicket)).toBe('epoch_changed');
    expect(terminal.goals.view(terminalSession, 1000)).toMatchObject({runtime: 'failed', estimateRevision: 0, prediction: null});
  });

  it('reports missing tickets without overwriting a consumed ticket reason', () => {
    const f = fixture();
    const session = f.hook('UserPromptSubmit', 0);
    const missing = {};
    expect(f.goals.settle(missing, answer(), 1000)).toBe(false);
    expect(f.goals.rejectionReason(missing)).toBe('ticket_missing');

    const consumed = f.request(1000).ticket;
    expect(f.goals.settle(consumed, {relation: 'replace'}, 1000)).toBe(false);
    expect(f.goals.settle(consumed, answer(), 1000)).toBe(false);
    expect(f.goals.rejectionReason(consumed)).toBe('schema_invalid');
    expect(f.goals.view(session, 1000)).toMatchObject({estimateRevision: 0, prediction: null});
  });
});
