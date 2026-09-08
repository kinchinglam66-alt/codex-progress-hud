import {it,expect} from 'vitest';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createPilotJournal} from '../../src/evaluation/pilot-journal.js';

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
    for(const triggerReason of ['initial','important_event','status_evidence','overdue','periodic','pre_dispatch_retry']){
      journal.record({...base,...{triggerReason,lastRequestActiveSeconds:15,eligibleActiveSeconds:315,secret:'PRIVATE_CONTEXT'}});
    }
    journal.record({...base,...{triggerReason:'PRIVATE_REASON',lastRequestActiveSeconds:Infinity,eligibleActiveSeconds:-1}});
    await journal.close();
    const names=await readdir(directory);
    const raw=await readFile(resolve(directory,names[0]!),'utf8');
    const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
    expect(rows.slice(0,6).map(row=>row.triggerReason)).toEqual(['initial','important_event','status_evidence','overdue','periodic','pre_dispatch_retry']);
    expect(rows[0]).toMatchObject({lastRequestActiveSeconds:15,eligibleActiveSeconds:315});
    expect(rows[6]).not.toHaveProperty('triggerReason');
    expect(rows[6]).not.toHaveProperty('lastRequestActiveSeconds');
    expect(rows[6]).not.toHaveProperty('eligibleActiveSeconds');
    expect(raw).not.toMatch(/PRIVATE_REASON|PRIVATE_CONTEXT/);
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
