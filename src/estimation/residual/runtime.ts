import {createHash,randomBytes} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createResidualRecorder} from './recorder.js';
import {parseArtifact,predictResidual,type ResidualArtifact} from './predict.js';
import {prefixSchema,freezeData,parseResearchRecord,type Prefix,type Identity,type PrefixFailure} from './contract.js';
import {ResearchLifecycle} from './lifecycle.js';
import type {ActionFeatures} from './capture.js';
import type {ResearchOwner,ResearchBoundary} from './telemetry.js';
import type {ForecastVersions} from '../forecast-record.js';

export interface ResidualRuntime {
  capture(owner:ResearchOwner,predictionId:number,watermark:string,activeSeconds:number,actions:ActionFeatures):object;
  accept(ticket:object,rawSeconds:number,deliveredActiveSeconds:number,versions:ForecastVersions):boolean;
  unavailable(owner:ResearchOwner,predictionId:number,rawSeconds:number,deliveredActiveSeconds:number,versions:ForecastVersions,detail?:PrefixFailure):void;
  boundary(event:ResearchBoundary):void;
  forget(sessionKey:string):void;
  close():Promise<void>;
}
export async function createResidualRuntime(directory:string):Promise<ResidualRuntime>{
  const recorder=await createResidualRecorder(directory),runId=randomBytes(16).toString('hex');
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  let sequence=0,closed=false,artifact:ResidualArtifact|null=null;
  try{
    const path=resolve(directory,'artifact.json'),stat=await lstat(path);
    if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=1024*1024)artifact=parseArtifact(JSON.parse(await readFile(path,'utf8')));
  }catch{/* No usable artifact: recording and raw ETA remain available. */}
  const life=new ResearchLifecycle(()=>++sequence);
  type Owned={owner:ResearchOwner;identity:Identity;birth:number;ended:boolean};
  const owners=new Map<string,Owned>(),tickets=new WeakMap<object,{prefix:Prefix;owned:Owned}>();
  const same=(a:ResearchOwner,b:ResearchOwner)=>a.sessionKey===b.sessionKey&&a.turnKey===b.turnKey&&a.sourceEpoch===b.sourceEpoch&&a.generation===b.generation;
  const forget=(sessionKey:string)=>{
    const owned=owners.get(sessionKey);if(!owned)return;
    if(!owned.ended)recorder.record(life.invalidate(owned.identity,'clock_unknown'));
    life.forget(owned.identity);owners.delete(sessionKey);
  };
  return {
    capture(owner,predictionId,watermark,activeSeconds,actions){
      const ticket=Object.freeze({});if(closed)return ticket;
      let owned=owners.get(owner.sessionKey);
      if(owned&&!same(owned.owner,owner)){forget(owner.sessionKey);owned=undefined;}
      if(!owned){
        if(owners.size>=256)forget(owners.keys().next().value!);
        const identity={...recorder.identify('local',owner.sessionKey,owner.turnKey),runId,sourceEpoch:owner.sourceEpoch,generation:owner.generation};
        owned={owner:{...owner},identity,birth:activeSeconds,ended:false};owners.set(owner.sessionKey,owned);
      }
      if(owned.ended)return ticket;
      const prefix=freezeData(prefixSchema.parse({identity:owned.identity,predictionId,watermark:hash(watermark),anchorActiveSeconds:activeSeconds,
        features:{...actions,elapsedActiveSeconds:null,observedActiveSeconds:activeSeconds-owned.birth}}));
      tickets.set(ticket,{prefix,owned});return ticket;
    },
    accept(ticket,rawSeconds,deliveredActiveSeconds,versions){
      const captured=tickets.get(ticket);tickets.delete(ticket);
      if(closed||!captured||owners.get(captured.owned.owner.sessionKey)!==captured.owned||captured.owned.ended)return false;
      try{
        const features={...captured.prefix.features,rawSeconds};
        recorder.record(parseResearchRecord({schemaVersion:1,kind:'forecast',sequence:++sequence,prefix:captured.prefix,
          rawSeconds,deliveredActiveSeconds,versions,shadow:predictResidual(artifact,features,versions)}));
        return true;
      }catch{recorder.record(life.invalidate(captured.owned.identity,'recording_gap'));return false;}
    },
    unavailable(owner,predictionId,rawSeconds,deliveredActiveSeconds,versions,detail){
      if(closed)return;
      recorder.record(parseResearchRecord({schemaVersion:1,kind:'unavailable_forecast',sequence:++sequence,
        identity:{...recorder.identify('local',owner.sessionKey,owner.turnKey),runId,sourceEpoch:owner.sourceEpoch,generation:owner.generation},
        predictionId,rawSeconds,deliveredActiveSeconds,versions,reason:'prefix_unavailable',...(detail===undefined?{}:{detail})}));
    },
    boundary(event){
      if(closed)return;const owned=owners.get(event.sessionKey);
      if(!owned)return;if(!same(owned.owner,event)){forget(event.sessionKey);return;}
      try{
        for(const row of life.transition(owned.identity,{id:hash(event.evidenceId),atActiveSeconds:event.activeSeconds,
          state:event.state,trusted:event.trusted,...(event.outcome===undefined?{}:{outcome:event.outcome})}))recorder.record(row);
        if(event.outcome!==undefined)owned.ended=true;
      }catch{recorder.record(life.invalidate(owned.identity,'clock_unknown'));}
    },
    forget,
    async close(){if(closed)return;closed=true;for(const key of [...owners.keys()])forget(key);await recorder.close();},
  };
}
