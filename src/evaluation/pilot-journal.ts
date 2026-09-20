import type {ObserverObservation} from '../estimation/observer-scheduler.js';
import {projectRequestProfile} from '../estimation/request-profile.js';
import {observerCallStages} from '../estimation/observer-provider.js';
import {milestoneTelemetrySchema} from '../estimation/progress-state.js';
import {makeForecastRecord} from '../estimation/forecast-record.js';
import {createHmac,randomUUID} from 'node:crypto';
import {mkdir,open,type FileHandle} from 'node:fs/promises';
import {resolve} from 'node:path';
import {resultDiagnostics,resultRejectionReasons,observerContextStates} from '../core/observer-diagnostics.js';

const triggerCodes=new Set(['initial','important_event','status_evidence','near_expiry','overdue','periodic','pre_dispatch_retry','bootstrap_recovery']);
const forecastDiagnosticCodes=new Set(['provenance_unavailable','invalid_provenance']);
const resultDiagnosticCodes=new Set(resultDiagnostics);
const resultRejectionReasonCodes=new Set(resultRejectionReasons);
const stageCodes=new Set(observerCallStages);
const contextStateCodes=new Set(observerContextStates);
const activeAnchor=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=31_536_000?value:undefined;
function contextMetrics(value:unknown){
  if(!value||typeof value!=='object')return undefined;
  const data=value as Record<string,unknown>;
  if(data.sizing!=='tokenizer'&&data.sizing!=='conservative')return undefined;
  const fields=['originalTextBytes','originalTextTokenEstimate','preparedRequestBytes','preparedTokenEstimate','compressionCalls','cachedCompressionCalls'] as const;
  if(fields.some(key=>typeof data[key]!=='number'||!Number.isSafeInteger(data[key])||(data[key] as number)<0))return undefined;
  return {sizing:data.sizing,...Object.fromEntries(fields.map(key=>[key,data[key]]))};
}

/** Local research metadata only. Bounded asynchronous I/O never gates model work.
 * Missing terminal summary means an unclean recording shutdown, not completion. */
export function createPilotJournal(directory:string,options:{now?:()=>number;openFile?:typeof open}={}){
  const now=options.now??Date.now,openFile=options.openFile??open;
  const session=randomUUID(),salt=randomUUID();
  let file:FileHandle|undefined,tail=Promise.resolve(),closing:Promise<void>|undefined;
  let written=0,dropped=0,failed=false,pending=0,bytes=0;
  let failures=0,retryAt=0,created=false;
  let lastError:'EACCES'|'EPERM'|'ENOSPC'|'EIO'|'EBUSY'|'EEXIST'|'unknown'|null=null;
  const pendingRequests=new Set<number>();
  const status=()=>({written,dropped,failed,failures,lastError,retryAt:failed&&failures<=3&&lastError!=='EEXIST'?retryAt:null});
  async function handle(){
    if(!file){await mkdir(directory,{recursive:true});file=await openFile(resolve(directory,`pilot-${session}.jsonl`),created?'a':'wx',0o600);created=true;}
    return file;
  }
  async function fail(error:unknown){
    failed=true;failures++;retryAt=now()+30_000;dropped++;
    const code=(error as NodeJS.ErrnoException|null)?.code;
    lastError=['EACCES','EPERM','ENOSPC','EIO','EBUSY','EEXIST'].includes(code??'')?code as Exclude<typeof lastError,null|'unknown'>:'unknown';
    const previous=file;file=undefined;await previous?.close().catch(()=>undefined);
  }
  const canRetry=()=>failed&&failures<=3&&lastError!=='EEXIST'&&now()>=retryAt;
  return {
    record(value:ObserverObservation):void {
      if(closing || (failed&&!canRetry()) || pending>=128){dropped++;return;}
      let forecast:ReturnType<typeof makeForecastRecord>|undefined;
      const milestone=milestoneTelemetrySchema.safeParse(value.milestone);
      try {if(value.forecast)forecast=makeForecastRecord(value.forecast);} catch { /* Invalid research metadata is omitted. */ }
      // Explicit field projection prevents accidental future context/identity logging.
      const row={schemaVersion:1,session,recordedAt:Date.now(),kind:value.kind,at:value.at,
        ...(milestone.success?{milestone:milestone.data}:{}),eventCutoff:activeAnchor(value.eventCutoff),pendingCriticalEvents:activeAnchor(value.pendingCriticalEvents),
        key:createHmac('sha256',salt).update(value.key).digest('hex'),generation:value.generation,
        activeSeconds:value.activeSeconds,activeTimeKnown:value.activeTimeKnown,runtime:value.runtime,version:value.version,
        timingUncertain:typeof value.timingUncertain==='boolean'?value.timingUncertain:undefined,
        recoveryState:value.recoveryState==='pending'||value.recoveryState==='restored'?value.recoveryState:undefined,
        recoveryGapSeconds:value.recoveryGapSeconds===null?null:activeAnchor(value.recoveryGapSeconds),
        requestId:value.requestId,requestedAt:value.requestedAt,observedActiveSeconds:value.observedActiveSeconds,
        stage:value.kind==='stage'&&value.stage!==undefined&&stageCodes.has(value.stage)?value.stage:undefined,
        contextState:value.contextState!==undefined&&contextStateCodes.has(value.contextState)?value.contextState:undefined,
        contextMetrics:contextMetrics(value.contextMetrics),
        requestProfile:projectRequestProfile(value.requestProfile),
        triggerReason:typeof value.triggerReason==='string'&&triggerCodes.has(value.triggerReason)?value.triggerReason:undefined,
        lastRequestActiveSeconds:activeAnchor(value.lastRequestActiveSeconds),
        eligibleActiveSeconds:activeAnchor(value.eligibleActiveSeconds),
         accepted:value.accepted,status:value.status,relation:value.relation,
         resultDiagnostic:typeof value.resultDiagnostic==='string'&&resultDiagnosticCodes.has(value.resultDiagnostic)?value.resultDiagnostic:undefined,
         rejectionReason:typeof value.rejectionReason==='string'&&resultRejectionReasonCodes.has(value.rejectionReason)?value.rejectionReason:undefined,
        timings:value.timings?{preparationMs:value.timings.preparationMs,providerMs:value.timings.providerMs,
          settlementMs:value.timings.settlementMs,deliveryMs:value.timings.deliveryMs,totalMs:value.timings.totalMs}:undefined,
        estimate:value.estimate?{remainingSeconds:value.estimate.remainingSeconds,errorPercent:value.estimate.errorPercent}:value.estimate,
        usage:value.usage?{kind:value.usage.kind,inputTokens:value.usage.inputTokens,outputTokens:value.usage.outputTokens,cachedInputTokens:value.usage.cachedInputTokens}:value.usage,
        ...(forecast?{forecast:{schemaVersion:forecast.schemaVersion,predictionId:forecast.predictionId,generation:forecast.generation,
          snapshotActiveSeconds:forecast.snapshotActiveSeconds,acceptedAt:forecast.acceptedAt,rawSeconds:forecast.rawSeconds,
          shadowSeconds:forecast.shadowSeconds,paceReason:forecast.paceReason,calibration:forecast.calibration,
          ...(forecast.measurement?{measurement:{source:forecast.measurement.source,clock:forecast.measurement.clock,
            remainingUnitsProvenance:forecast.measurement.remainingUnitsProvenance,sampleCount:forecast.measurement.sampleCount}}:{}),
          versions:{input:forecast.versions.input,prompt:forecast.versions.prompt,model:forecast.versions.model,algorithm:forecast.versions.algorithm}}}:{}),
        ...(typeof value.forecastDiagnostic==='string'&&forecastDiagnosticCodes.has(value.forecastDiagnostic)?
          {forecastDiagnostic:value.forecastDiagnostic}:{} )};
      const line=JSON.stringify(row)+'\n',size=Buffer.byteLength(line);
      if(size>8192 || bytes+size>10*1024*1024){dropped++;return;}
      if(value.requestId!==undefined){
        if(value.kind==='request')pendingRequests.add(value.requestId);
        if(value.kind==='result')pendingRequests.delete(value.requestId);
      }
      bytes+=size;pending++;
      tail=tail.then(async()=>{
        if(failed&&!canRetry()){dropped++;return;}
        try{
          const target=await handle();
          if(failed){
            // Preserve any partial failed line. A leading newline separates it
            // from the explicit gap; never rewrite history or replay a result.
            await target.writeFile('\n'+JSON.stringify({schemaVersion:1,session,kind:'journal_gap',recordedAt:now(),failures,dropped,lastError})+'\n');
            failed=false;
          }
          await target.writeFile(line);written++;
        }catch(error){await fail(error);}
      }).finally(()=>{pending--;});
    },
    status,
    flush():Promise<void>{return tail;},
    close():Promise<void>{
      if(closing)return closing;
      closing=tail.then(async()=>{
        if(!file)return;
        try{await file.writeFile(JSON.stringify({schemaVersion:1,session,kind:'journal_summary',...status(),pendingRequests:pendingRequests.size})+'\n');await file.sync();}
        catch{failed=true;}finally{await file.close().catch(()=>{failed=true;});}
      });
      return closing;
    },
  };
}
