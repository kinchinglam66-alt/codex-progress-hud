import {it,expect} from 'vitest';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createPersistentReceiptJournal} from '../../src/estimation/observer-persistent-receipt.js';
import {createPilotJournal} from '../../src/evaluation/pilot-journal.js';
import {requestCorrelation,withRequestCorrelation} from '../../src/estimation/request-correlation.js';
it('joins preparation failures, operations and unknown usage without putting identities in pilot metadata',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'eta-correlation-')),receipt=createPersistentReceiptJournal(directory),pilot=createPilotJournal(join(directory,'pilot'));
 const signal=new AbortController().signal,correlationId=requestCorrelation(signal),ownerUuid=randomUUID(),operationId=randomUUID(),admissionId=randomUUID();
 await withRequestCorrelation(signal,async()=>{
  await receipt.preparationFailed!({ownerUuid,sourceKey:'private-thread',generation:0,stage:'session_setup',code:'PREPARATION_UNKNOWN'});
  await receipt.operationStarted({ownerUuid,operationId,admissionId,sourceKey:'private-thread',generation:0});
  await receipt.usageGap({operationId,sourceKey:'private-thread',generation:0,observedAt:1,reason:'missing'});
  await receipt.operationTerminal({ownerUuid,operationId,admissionId,sourceKey:'private-thread',generation:0,terminalState:'completed',usageCompleteness:'missing'});
 });
 pilot.record({kind:'result',at:1,key:'private-thread',generation:0,activeSeconds:1,runtime:'running',version:1,correlationId,usage:null,
  estimateUncertain:true,completionPath:'uncertain',estimateCondition:{selectedPath:'report_blocker',displayPath:'report_blocker',issue:'conditional'},wireMetrics:{originalObservationBytes:100,sentObservationBytes:50,referencedMessages:1,retainedMessages:0,coverageDigest:'a'.repeat(64)}});
 await pilot.close();
 const receipts=(await readFile(join(directory,'persistent-session-receipts.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
 expect(receipts.every(r=>r.correlationId===correlationId)).toBe(true);expect(receipts[2].kind).toBe('usage_gap');expect(receipts[2].totalTokens).toBeUndefined();
 const raw=await readFile(join(directory,'pilot',(await readdir(join(directory,'pilot')))[0]!),'utf8');
 expect(raw).not.toContain('private-thread');const row=JSON.parse(raw.split('\n')[0]!);
 expect(row).toMatchObject({correlationId,usage:null,estimateUncertain:true,completionPath:'uncertain',estimateCondition:{selectedPath:'report_blocker',displayPath:'report_blocker',issue:'conditional'},wireMetrics:{referencedMessages:1}});
});
