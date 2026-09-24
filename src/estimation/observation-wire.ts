import {createHash} from 'node:crypto';
import type {ObserverInput} from './observer-contract.js';

export interface WireMetrics {originalObservationBytes:number;sentObservationBytes:number;referencedMessages:number;retainedMessages:number;coverageDigest:string}
export function projectWireMetrics(value:unknown):WireMetrics|undefined {
  if(!value||typeof value!=='object')return;
  const v=value as Record<string,unknown>;
  const keys=['originalObservationBytes','sentObservationBytes','referencedMessages','retainedMessages'] as const;
  if(!keys.every(k=>Number.isSafeInteger(v[k])&&(v[k] as number)>=0)||typeof v.coverageDigest!=='string'||!/^[a-f0-9]{64}$/.test(v.coverageDigest))return;
  return Object.fromEntries([...keys.map(k=>[k,v[k]]),['coverageDigest',v.coverageDigest]]) as unknown as WireMetrics;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** This index belongs to one live session. Add only ACKed complete records or
 * records explicitly carried before this observation in the same request. */
export function createObservationCoverage(){
  const records=new Map<number,string>();
  return {
    clear:()=>records.clear(),
    add(record:{ordinal:number;text:string;content?:unknown}){
      // Image records retain their full observation; no textual claim proves pixels.
      if(record.content!==undefined||!Number.isSafeInteger(record.ordinal)||record.ordinal<0)return;
      try{const r=JSON.parse(record.text);
        if(!r||!['user','assistant','tool_start','tool_result'].includes(r.kind)||
          !Number.isSafeInteger(r.atMs)||r.atMs<0||typeof r.text!=='string')return;
        records.set(record.ordinal,digest([r.kind,r.atMs,r.text]));
      }catch{/* Unknown representations retain the full observation. */}
    },
    project(input:ObserverInput){
      const covered:Array<[number,string]>=[];
      const messages=input.messages.map(message=>{
        const e=message.event;
        if(message.truncated||!e||records.get(e.ordinal)!==digest([e.kind,e.atMs,message.text]))return message;
        const {text:_text,...metadata}=message;
        const reference={...metadata,sourceReference:{ordinal:e.ordinal}};
        if(Buffer.byteLength(JSON.stringify(reference))>=Buffer.byteLength(JSON.stringify(message)))return message;
        covered.push([e.ordinal,records.get(e.ordinal)!]);return reference;
      });
      const observation={...input,messages};
      const metrics:WireMetrics={originalObservationBytes:Buffer.byteLength(JSON.stringify(input)),sentObservationBytes:Buffer.byteLength(JSON.stringify(observation)),
        referencedMessages:covered.length,retainedMessages:messages.length-covered.length,coverageDigest:digest(covered)};
      return {observation,metrics};
    }
  };
}
