import {it,expect} from 'vitest';
import {mkdtemp,readFile,readdir,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createPilotJournal} from '../../src/evaluation/pilot-journal.js';
import {ETA_TIME_BASIS} from '../../src/core/eta-time-basis.js';

it('preserves clock basis on new rows without relabelling old rows or logging invalid flags',async()=>{
 const directory=await mkdtemp(resolve(tmpdir(),'hud-clock-basis-')),journal=createPilotJournal(directory);
 try{
  const base={kind:'result' as const,at:1,key:'private',generation:1,activeSeconds:1,runtime:'running',version:1};
  journal.record({...base,timeBasis:ETA_TIME_BASIS,blockingUnknown:true,humanBlocked:false});
  journal.record(base);
  journal.record({...base,timeBasis:ETA_TIME_BASIS,blockingUnknown:'PRIVATE' as any});
  await journal.close();
  const raw=await readFile(resolve(directory,(await readdir(directory))[0]!),'utf8');
  const rows=raw.trim().split('\n').map(s=>JSON.parse(s)).filter(r=>r.kind==='result');
  expect(rows[0]).toMatchObject({timeBasis:ETA_TIME_BASIS,blockingUnknown:true,humanBlocked:false});
  expect(rows[1].timeBasis).toBeUndefined();expect(raw).not.toContain('PRIVATE');
 }finally{await journal.close();await rm(directory,{recursive:true,force:true});}
});

it('records allowlisted milestone decisions and event counts without private definitions',async()=>{
 const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-milestone-'));
 try{
  const journal=createPilotJournal(directory);
  journal.record({kind:'result',at:42,key:'private-key',generation:1,activeSeconds:42,runtime:'running',version:2,
   pairedResultSequence:2,observedEventSequence:0,semanticReviewEventSequence:1,
   reviewOutcome:'not_provided',milestoneApplicationOutcome:'accepted',
   reviewEvidenceRefs:['ev_'+'b'.repeat(32)],
   lastObservedMilestone:{milestoneId:'ms_'+'c'.repeat(32),operationRef:'op_'+'d'.repeat(32),
    evidenceRef:'ev_'+'e'.repeat(32),sourceEndedAtMs:40000,actualRemainingActiveSeconds:null},
   milestone:{id:'ms_'+'a'.repeat(32),judgment:'in_progress',completionCriterion:'semantic',operationRef:null,
    prediction:{remainingSeconds:100,errorPercent:40,observedActiveSeconds:40}},
   ...{definition:'PRIVATE_CONTEXT',reviewOutcomeDetail:'PRIVATE_CONTEXT'}});
  await journal.close();
  const raw=await readFile(resolve(directory,(await readdir(directory))[0]!),'utf8');
  expect(JSON.parse(raw.split('\n')[0]!)).toMatchObject({pairedResultSequence:2,observedEventSequence:0,
   semanticReviewEventSequence:1,reviewOutcome:'not_provided',milestoneApplicationOutcome:'accepted',
   milestone:{completionCriterion:'semantic',operationRef:null},reviewEvidenceRefs:['ev_'+'b'.repeat(32)],
   lastObservedMilestone:{evidenceRef:'ev_'+'e'.repeat(32)}});
  expect(raw).not.toContain('PRIVATE_CONTEXT');expect(raw).not.toContain('private-key');
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('projects bounded per-result progress settlement metadata and leaves old or rejected rows unknown',async()=>{
 const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-progress-settlement-')),journal=createPilotJournal(directory);
 try{
  const base={kind:'result' as const,at:1,key:'private',generation:1,activeSeconds:1,runtime:'running' as const,version:1};
  const diagnostic={responseKind:'provided',outcome:'aged_numeric_only',detail:'PRIVATE_CONTEXT'} as const;
  journal.record({...base,accepted:true,progressSettlement:diagnostic});
  journal.record({...base,accepted:false,progressSettlement:diagnostic});
  journal.record({...base,accepted:true});
  journal.record({...base,accepted:true,progressSettlement:{...diagnostic,outcome:'PRIVATE_CONTEXT'} as any});
  await journal.close();
  const raw=await readFile(resolve(directory,(await readdir(directory))[0]!),'utf8');
  expect(raw).not.toContain('PRIVATE_CONTEXT');
  const rows=raw.trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.kind==='result');
  expect(rows.map(row=>row.progressSettlement)).toEqual([{responseKind:'provided',outcome:'aged_numeric_only'},undefined,undefined,undefined]);
 }finally{await journal.close();await rm(directory,{recursive:true,force:true});}
});

it('persists only normalized admission reasons for denied results',async()=>{
 const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-admission-')),journal=createPilotJournal(directory);
 try{
  for(const reason of ['cooldown','unresolved_previous_call','PRIVATE-ERROR'])journal.record({kind:'result',at:1,key:'private',generation:1,activeSeconds:1,runtime:'running',version:1,status:'admission_denied',admissionReason:reason as any});
  await journal.close();
  const raw=await readFile(resolve(directory,(await readdir(directory))[0]!),'utf8');
  expect(raw).not.toContain('PRIVATE-ERROR');
  expect(raw.trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.kind==='result').map(row=>row.admissionReason)).toEqual(['cooldown','unresolved_previous_call','local_policy']);
 }finally{await journal.close();await rm(directory,{recursive:true,force:true});}
});

it.each([undefined,'aged_response_no_estimate','estimate_expired_on_arrival'] as const)('links a retained historical forecast to its review without writing definitions or changing clocks (rejection=%s)',async rejectionReason=>{
 const accepted=rejectionReason===undefined;
 const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-pending-milestone-')),journal=createPilotJournal(directory);
 const id='pc_'+'a'.repeat(32),evidence='ev_'+'b'.repeat(32);
 const base={kind:'result' as const,at:2,key:'private',generation:1,activeSeconds:20,runtime:'running' as const,version:1,accepted:true};
 try{
  journal.record({...base,pendingMilestoneDecision:{retained:true,reviewOutcome:'not_provided',retainedCandidate:{id,observedActiveSeconds:1,sourceRevision:4,completionCriterion:'semantic',estimate:{remainingSeconds:100,errorPercent:30}},...{definition:'PRIVATE_CONTEXT'}}});
  journal.record({...base,accepted,...(rejectionReason?{rejectionReason}:{}),pendingMilestoneDecision:{retained:false,reviewOutcome:'reviewed',candidateId:id,assessment:'inferred_complete',evidenceRefs:[evidence],snapshotActiveSeconds:10,sourceRevision:8}});
  await journal.close();const raw=await readFile(resolve(directory,(await readdir(directory))[0]!),'utf8');
  expect(raw).not.toContain('PRIVATE_CONTEXT');
  const rows=raw.trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.kind==='result');
  expect(rows[0].pendingMilestoneDecision.retainedCandidate).toMatchObject({id,observedActiveSeconds:1,sourceRevision:4});
  expect(rows[1].pendingMilestoneDecision).toMatchObject({candidateId:id,assessment:'inferred_complete',snapshotActiveSeconds:10,sourceRevision:8});
  expect(rows[1].activeSeconds).toBe(20);
  expect(rows[1].accepted).toBe(accepted);
 }finally{await journal.close();await rm(directory,{recursive:true,force:true});}
});

it('recovers a transient open failure with an explicit gap and bounded retries',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-retry-'));
  let clock=0,attempts=0;
  const journal=createPilotJournal(directory,{now:()=>clock,openFile:async(...args)=>{
    if(attempts++===0)throw Object.assign(Error('PRIVATE'),{code:'EBUSY'});
    return open(...args);
  }});
  const row={kind:'runtime' as const,at:1,key:'private',generation:1,activeSeconds:1,runtime:'running',version:1};
  try{
    journal.record(row);await journal.flush();
    expect(journal.status()).toMatchObject({failed:true,lastError:'EBUSY',failures:1});
    journal.record(row);await journal.flush();expect(attempts).toBe(1);
    clock=30000;journal.record(row);await journal.flush();await journal.close();
    const raw=await readFile(resolve(directory,(await readdir(directory))[0]!),'utf8');
    expect(raw).not.toContain('PRIVATE');
    expect(raw.trim().split('\n').map(x=>JSON.parse(x).kind)).toEqual(['journal_gap','runtime','journal_summary']);
    expect(journal.status()).toMatchObject({failed:false,failures:1,dropped:2,written:1});
  }finally{await journal.close();await rm(directory,{recursive:true,force:true});}
});

it('stops retrying persistent failures without creating an unbounded retry loop',async()=>{
  let clock=0,attempts=0;
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-fail-'));
  const journal=createPilotJournal(directory,{now:()=>clock,openFile:async()=>{attempts++;throw Object.assign(Error('PRIVATE'),{code:'ENOSPC'});}});
  try{
    for(let i=0;i<10;i++){clock=i*30000;journal.record({kind:'runtime',at:clock,key:'x',generation:1,activeSeconds:1,runtime:'running',version:1});await journal.flush();}
    expect(attempts).toBe(4);expect(journal.status()).toMatchObject({failed:true,failures:4,retryAt:null,lastError:'ENOSPC'});
  }finally{await journal.close();await rm(directory,{recursive:true,force:true});}
});

it('preserves a partial write and marks the gap without replaying the failed record',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-partial-'));
  let clock=0,first=true;
  const journal=createPilotJournal(directory,{now:()=>clock,openFile:async(...args)=>{
    const handle=await open(...args);
    if(first){first=false;const write=handle.writeFile.bind(handle);
      handle.writeFile=async()=>{await write('{"partial":');throw Object.assign(Error('PRIVATE'),{code:'EIO'});};
    }
    return handle;
  }});
  try{
    const row={kind:'runtime' as const,at:1,key:'x',generation:1,activeSeconds:1,runtime:'running',version:1};
    journal.record(row);await journal.flush();clock=30000;
    journal.record({...row,at:2});await journal.flush();await journal.close();
    const raw=await readFile(resolve(directory,(await readdir(directory))[0]!),'utf8');
    expect(raw.startsWith('{"partial":\n')).toBe(true);
    const rows=raw.trim().split('\n').slice(1).map(line=>JSON.parse(line));
    expect(rows.map(row=>row.kind)).toEqual(['journal_gap','runtime','journal_summary']);
    expect(rows[1].at).toBe(2);expect(rows[0].lastError).toBe('EIO');
    expect(journal.status()).toMatchObject({written:1,dropped:1,failures:1,failed:false});
  }finally{await journal.close();await rm(directory,{recursive:true,force:true});}
});

it('persists request phase measurements without leaking injected context',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-profile-'));
  try{
    const journal=createPilotJournal(directory);
    journal.record({kind:'result',at:1,key:'private',generation:1,activeSeconds:1,runtime:'running',version:1,
      requestProfile:{sourceMs:5,totalMs:15,inferenceMs:10,clockValid:true,accountProcessMs:null,
        forkImportMs:null,compactionMs:null,deliveryMs:null,unattributedMs:null,...{secret:'PRIVATE_CONTEXT'}}});
    await journal.close();
    const raw=await readFile(resolve(directory,(await readdir(directory))[0]!),'utf8');
    expect(JSON.parse(raw.split('\n')[0]!).requestProfile).toMatchObject({sourceMs:5,totalMs:15,inferenceMs:10,
      accountProcessMs:null,clockValid:true});
    expect(raw).not.toContain('PRIVATE_CONTEXT');
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('records context representation state but never raw context',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-context-'));
  try{
    const journal=createPilotJournal(directory);
    const base={kind:'stage' as const,at:50,key:'private',generation:1,activeSeconds:100,runtime:'running',version:1};
    const contextMetrics={sizing:'conservative' as const,originalTextBytes:10000,originalTextTokenEstimate:10000,
      preparedRequestBytes:5000,preparedTokenEstimate:5000,compressionCalls:2,cachedCompressionCalls:1};
    journal.record({...base,contextState:'context_compressed',...{contextMetrics,rawContext:'SYNTHETIC_SECRET'}});
    journal.record({...base,contextState:'SYNTHETIC_SECRET' as never});
    await journal.close();
    const raw=await readFile(resolve(directory,(await readdir(directory))[0]!),'utf8');
    expect(JSON.parse(raw.split('\n')[0]!)).toMatchObject({contextState:'context_compressed'});
    expect(JSON.parse(raw.split('\n')[0]!)).toMatchObject({contextMetrics});
    expect(raw).not.toContain('SYNTHETIC_SECRET');
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('records recovery uncertainty without accepting arbitrary diagnostic text',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-recovery-'));
  try{
    const journal=createPilotJournal(directory);
    const base={kind:'runtime' as const,at:50,key:'private',generation:1,activeSeconds:100,runtime:'running',version:1};
    journal.record({...base,recoveryState:'restored',recoveryGapSeconds:600,timingUncertain:true});
    journal.record({...base,recoveryState:'SECRET' as never,recoveryGapSeconds:Infinity,timingUncertain:'SECRET' as never});
    await journal.close();
    const raw=await readFile(resolve(directory,(await readdir(directory))[0]!),'utf8');
    const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
    expect(rows[0]).toMatchObject({recoveryState:'restored',recoveryGapSeconds:600,timingUncertain:true});
    expect(rows[1]).not.toHaveProperty('recoveryState');expect(rows[1]).not.toHaveProperty('recoveryGapSeconds');
    expect(raw).not.toContain('SECRET');
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('records allowlisted stages without closing an unresolved request or leaking raw details',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-stages-'));
  try{
    const journal=createPilotJournal(directory);
    const base={at:1,key:'private',generation:0,activeSeconds:1,runtime:'running',version:1,requestId:9};
    journal.record({...base,kind:'request'});
    journal.record({...base,kind:'stage',stage:'settlement',...{details:'SECRET'}});
    journal.record({...base,kind:'stage',stage:'SECRET_STAGE' as never});
    await journal.close();
    const names=await readdir(directory);
    const raw=await readFile(resolve(directory,names[0]!),'utf8');
    const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
    expect(rows[1]).toMatchObject({kind:'stage',stage:'settlement',requestId:9});
    expect(rows[2]).not.toHaveProperty('stage');
    expect(rows.at(-1)).toMatchObject({pendingRequests:1});
    expect(raw).not.toContain('SECRET');
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('persists bounded metadata, not raw context, with an opaque session-local identity',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-'));
  try {
    const journal=createPilotJournal(directory);
    journal.record({kind:'request',at:15000,key:'private-thread-key',generation:1,activeSeconds:15,runtime:'running',version:2,requestId:1,
      timings:{preparationMs:1,providerMs:2,settlementMs:3,deliveryMs:4,totalMs:10,...{secret:'SECRET'}},
      forecast:{schemaVersion:1,predictionId:1,generation:1,snapshotActiveSeconds:15,acceptedAt:15000,rawSeconds:600,shadowSeconds:null,
        paceReason:'missing_measurements',calibration:'uncalibrated',versions:{input:'facts-v1',prompt:'prompt-v1',model:'model-v1',algorithm:'pace-v1'}},
      ...{summary:'DO NOT STORE',messages:[{text:'SECRET'}]}});
    await journal.close();
    const names=await readdir(directory);
    expect(names).toHaveLength(1);
    const raw=await readFile(resolve(directory,names[0]!),'utf8');
    const row=JSON.parse(raw.split('\n')[0]!);
    expect(row).toMatchObject({kind:'request',at:15000,activeSeconds:15,requestId:1,
      timings:{preparationMs:1,providerMs:2,settlementMs:3,deliveryMs:4,totalMs:10}});
    expect(row.forecast).toMatchObject({schemaVersion:1,predictionId:1,generation:1,rawSeconds:600,shadowSeconds:null,
      paceReason:'missing_measurements',versions:{input:'facts-v1',prompt:'prompt-v1',model:'model-v1',algorithm:'pace-v1'}});
    expect(row.key).toMatch(/^[a-f0-9]{64}$/);
    expect(raw).not.toMatch(/private-thread-key|SECRET|DO NOT STORE/);
    expect(journal.status()).toMatchObject({written:1,dropped:0,failed:false});
    expect(JSON.parse(raw.trim().split('\n').at(-1)!)).toMatchObject({pendingRequests:1});
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('bounds queued records and reports truncation instead of growing without limit',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-cap-'));
  try {
    const journal=createPilotJournal(directory);
    for(let at=0;at<200;at++)journal.record({kind:'runtime',at,key:'one',generation:1,activeSeconds:at,runtime:'running',version:at});
    await journal.close();
    expect(journal.status()).toMatchObject({written:128,dropped:72,failed:false});
    const names=await readdir(directory);
    const rows=(await readFile(resolve(directory,names[0]!),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(rows.at(-1)).toMatchObject({kind:'journal_summary',written:128,dropped:72});
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('persists only allowed trigger codes and finite active-time anchors',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-triggers-'));
  try{
    const journal=createPilotJournal(directory);
    const base={kind:'request' as const,at:300000,key:'private',generation:1,activeSeconds:300,runtime:'running',version:1};
    for(const triggerReason of ['initial','important_event','status_evidence','overdue','periodic','pre_dispatch_retry','near_expiry']){
      journal.record({...base,...{triggerReason,lastRequestActiveSeconds:15,eligibleActiveSeconds:315,secret:'PRIVATE_CONTEXT'}});
    }
    journal.record({...base,...{triggerReason:'PRIVATE_REASON',lastRequestActiveSeconds:Infinity,eligibleActiveSeconds:-1}});
    await journal.close();
    const names=await readdir(directory);
    const raw=await readFile(resolve(directory,names[0]!),'utf8');
    const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
    expect(rows.slice(0,7).map(row=>row.triggerReason)).toEqual(['initial','important_event','status_evidence','overdue','periodic','pre_dispatch_retry','near_expiry']);
    expect(rows[0]).toMatchObject({lastRequestActiveSeconds:15,eligibleActiveSeconds:315});
    expect(rows[7]).not.toHaveProperty('triggerReason');
    expect(rows[7]).not.toHaveProperty('lastRequestActiveSeconds');
    expect(rows[7]).not.toHaveProperty('eligibleActiveSeconds');
    expect(raw).not.toMatch(/PRIVATE_REASON|PRIVATE_CONTEXT/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('persists bounded recovery and result diagnostics without raw provider details',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-recovery-diagnostic-'));
  try{
    const journal=createPilotJournal(directory);
    const base={kind:'result' as const,at:300000,key:'private',generation:1,activeSeconds:300,runtime:'running',version:1,
      requestId:2,accepted:false,status:'interpreted',resultDiagnostic:'rejected_result' as const,
      rejectionReason:'result_not_accepted' as const,summary:'PRIVATE_CONTEXT'};
    journal.record({...base,triggerReason:'bootstrap_recovery' as const,...({providerMessage:'PRIVATE_PROVIDER_MESSAGE'} as Record<string,unknown>)});
    await journal.close();
    const names=await readdir(directory);
    const raw=await readFile(resolve(directory,names[0]!),'utf8');
    const row=JSON.parse(raw.split('\n')[0]!);
    expect(row).toMatchObject({triggerReason:'bootstrap_recovery',resultDiagnostic:'rejected_result',rejectionReason:'result_not_accepted'});
    expect(raw).not.toMatch(/PRIVATE_CONTEXT|PRIVATE_PROVIDER_MESSAGE/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('does not project an unrecognized forecast diagnostic',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-diagnostic-'));
  try{
    const journal=createPilotJournal(directory);
    journal.record({kind:'runtime',at:1,key:'private',generation:1,activeSeconds:1,runtime:'running',version:1,
      forecastDiagnostic:'PRIVATE_DIAGNOSTIC' as never});
    await journal.close();
    const names=await readdir(directory);
    const raw=await readFile(resolve(directory,names[0]!),'utf8');
    expect(JSON.parse(raw.split('\n')[0]!)).not.toHaveProperty('forecastDiagnostic');
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('persists API usage kind without relabeling it as subscription usage',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-api-'));
  try{
    const journal=createPilotJournal(directory);
    journal.record({kind:'result',at:1,key:'private',generation:1,activeSeconds:1,runtime:'running',version:1,
      usage:{kind:'api-tokens',inputTokens:4,outputTokens:2,cachedInputTokens:0}});
    await journal.close();
    const names=await readdir(directory);
    const raw=await readFile(resolve(directory,names[0]!),'utf8');
    expect(JSON.parse(raw.split('\n')[0]!).usage).toEqual({kind:'api-tokens',inputTokens:4,outputTokens:2,cachedInputTokens:0});
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('projects only the allowlisted admitted measurement metadata',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'hud-journal-measurement-'));
  try {
    const journal=createPilotJournal(directory);
    journal.record({kind:'result',at:1,key:'private',generation:1,activeSeconds:1,runtime:'running',version:1,
      forecast:{schemaVersion:1,predictionId:1,generation:1,snapshotActiveSeconds:1,acceptedAt:1,rawSeconds:100,shadowSeconds:40,
        paceReason:'eligible',calibration:'uncalibrated',measurement:{source:'vitest_json',clock:'tool_execution',remainingUnitsProvenance:'model_hypothesis',sampleCount:3},
        versions:{input:'facts-v1',prompt:'prompt-v1',model:'model-v1',algorithm:'pace-v1'}}});
    await journal.close();
    const names=await readdir(directory);
    const raw=await readFile(resolve(directory,names[0]!),'utf8');
    const row=JSON.parse(raw.split('\n')[0]!);
    expect(row.forecast.measurement).toEqual({source:'vitest_json',clock:'tool_execution',remainingUnitsProvenance:'model_hypothesis',sampleCount:3});
    expect(raw).not.toMatch(/measurementRef|path|signature/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
