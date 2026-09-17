export const requestProfilePhases=['sourceMs','accountProcessMs','forkImportMs','compactionMs','inferenceMs','deliveryMs','unattributedMs'] as const;
export type RequestProfilePhase=typeof requestProfilePhases[number];
export type RequestProfile=Record<RequestProfilePhase,number|null>&{totalMs:number|null;clockValid:boolean};
/** Exclusive host-observed wall time, not model compute time or UI paint time. */
export function createRequestProfile(now:()=>number=()=>performance.now(),initial:RequestProfilePhase='sourceMs'){
  let valid=true;
  const read=()=>{try{const value=now();if(Number.isFinite(value)&&value>=0)return value;}catch{/* Passive telemetry. */}valid=false;return 0;};
  const start=read();let last=start,current:RequestProfilePhase=initial;
  const values:Record<RequestProfilePhase,number|null>={sourceMs:null,accountProcessMs:null,
    forkImportMs:null,compactionMs:null,inferenceMs:null,deliveryMs:null,unattributedMs:null};values[initial]=0;
  const advance=()=>{const at=read();if(at<last)valid=false;
    if(valid)values[current]=(values[current]??0)+at-last;last=at;};
  return {
    phase(value:RequestProfilePhase){if(!requestProfilePhases.includes(value))return;advance();current=value;values[value]??=0;},
    snapshot():RequestProfile{advance();return {...Object.fromEntries(requestProfilePhases.map(key=>[key,valid?values[key]:null])) as Record<RequestProfilePhase,number|null>,
      totalMs:valid?last-start:null,clockValid:valid};}
  };
}
export function projectRequestProfile(value:unknown):RequestProfile|undefined{
  if(!value||typeof value!=='object')return undefined;
  const data=value as Record<string,unknown>;
  const duration=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=86_400_000?v:null;
  return {...Object.fromEntries(requestProfilePhases.map(key=>[key,duration(data[key])])) as Record<RequestProfilePhase,number|null>,
    totalMs:duration(data.totalMs),clockValid:data.clockValid===true};
}
