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
      ...{summary:'DO NOT STORE',messages:[{text:'SECRET'}]}});
    await journal.close();
    const names=await readdir(directory);
    expect(names).toHaveLength(1);
    const raw=await readFile(resolve(directory,names[0]!),'utf8');
    const row=JSON.parse(raw.split('\n')[0]!);
    expect(row).toMatchObject({kind:'request',at:15000,activeSeconds:15,requestId:1,
      timings:{preparationMs:1,providerMs:2,settlementMs:3,deliveryMs:4,totalMs:10}});
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
