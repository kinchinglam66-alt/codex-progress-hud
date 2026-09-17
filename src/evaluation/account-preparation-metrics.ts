import type {SessionAccountReuse} from '../estimation/session-account-reuse.js';

/** Deliberately reconstruct diagnostics rather than logging an identity object. */
export function readAccountCacheDiagnostic(value:unknown) {
  const reasons=['empty','expired','wall-clock-rollback','monotonic-clock-rollback','nonfinite-clock',
    'evidence-expired','generation-fenced','local-guard-failed','cancelled','publication-rejected','explicit'];
  try{
    if(typeof value!=='object'||value===null||Array.isArray(value))return null;
    const source=value as Record<string,unknown>;
    const candidateCount=source.candidateCount,hitCount=source.hitCount,missCount=source.missCount,
      localGuardCount=source.localGuardCount,localGuardMs=source.localGuardMs,lastMissReason=source.lastMissReason;
    if(![candidateCount,hitCount,missCount,localGuardCount].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)||
      typeof localGuardMs!=='number'||!Number.isFinite(localGuardMs)||localGuardMs<0||localGuardMs>Number.MAX_SAFE_INTEGER||
      !(lastMissReason===null||typeof lastMissReason==='string'&&reasons.includes(lastMissReason)))return null;
    return {candidateCount:candidateCount as number,hitCount:hitCount as number,missCount:missCount as number,
      localGuardCount:localGuardCount as number,localGuardMs,lastMissReason};
  }catch{return null;}
}

/** Diagnostic-only adapter; never supplies authorization or retries work. */
export function createAccountPreparationMetrics(now:()=>number) {
  const values={prepareCalls:0,prepareSucceeded:0,prepareMs:0,reuseIssued:0,
    claimCalls:0,claimHits:0,claimMs:0,validateCalls:0,validatePassed:0,validateMs:0,timingUnavailable:0};
  const readClock=()=>{try{const value=now();return Number.isFinite(value)?value:null;}catch{return null;}};
  async function timed<T>(key:'prepareMs'|'claimMs'|'validateMs',operation:()=>Promise<T>):Promise<T> {
    const start=readClock();
    try{return await operation();}
    finally{
      const end=readClock();
      if(start===null||end===null||end<start)values.timingUnavailable++;
      else values[key]+=end-start;
    }
  }
  function wrap(reuse:SessionAccountReuse):SessionAccountReuse {
    return Object.freeze({
      invalidate:()=>reuse.invalidate(),
      claim:async(signal:AbortSignal)=>{
        values.claimCalls++;
        const proof=await timed('claimMs',()=>reuse.claim(signal));
        if(!proof)return null;
        values.claimHits++;
        return Object.freeze({
          valid:()=>proof.valid(),
          validate:async(nextSignal:AbortSignal)=>{
            values.validateCalls++;
            const passed=await timed('validateMs',()=>proof.validate(nextSignal));
            if(passed)values.validatePassed++;
            return passed;
          }
        });
      }
    });
  }
  return {
    snapshot:()=>({...values}),
    prepare:async<T extends {reuse?:SessionAccountReuse|undefined}>(operation:()=>Promise<T>):Promise<T>=>{
      values.prepareCalls++;
      const prepared=await timed('prepareMs',operation);
      values.prepareSucceeded++;
      if(!prepared.reuse)return prepared;
      values.reuseIssued++;
      return {...prepared,reuse:wrap(prepared.reuse)};
    }
  };
}
