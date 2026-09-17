export interface SessionAccountProof {
  validate(signal:AbortSignal):Promise<boolean>;
  valid():boolean;
}

export interface SessionAccountReuse {
  claim(signal:AbortSignal):Promise<SessionAccountProof|null>;
  invalidate():void;
}

interface SessionAccountReuseIssuerOptions {
  now:()=>number;
  monotonicNow:()=>number;
}

interface SessionAccountReuseInput {
  observedAt:number;
  observedMonotonic:number;
  expiresAt:number;
  validateLocal:(signal:AbortSignal)=>Promise<boolean>;
}

const REUSE_WINDOW_MS=30_000;

/**
 * Creates memory-only, one-use account proof handles. The issuer deliberately
 * exposes no serializable payload: callers receive behavior, not credentials
 * or identity metadata.
 */
export function createSessionAccountReuseIssuer(options:SessionAccountReuseIssuerOptions) {
  let generation=0;

  const issue=(input:SessionAccountReuseInput):SessionAccountReuse=>{
    const captured=Object.freeze({observedAt:input.observedAt,observedMonotonic:input.observedMonotonic,
      expiresAt:input.expiresAt,validateLocal:input.validateLocal});
    const issuedGeneration=generation;
    let consumed=false;
    let dead=false;
    let lastWall=captured.observedAt;
    let lastMonotonic=captured.observedMonotonic;

    const invalidate=()=>{dead=true;};
    const valid=():boolean=>{
      if(dead || issuedGeneration!==generation)return false;
      try {
        const wall=options.now();
        const monotonic=options.monotonicNow();
        if(!Number.isFinite(wall)||!Number.isFinite(monotonic)||
          !Number.isFinite(captured.observedAt)||!Number.isFinite(captured.observedMonotonic)||!Number.isFinite(captured.expiresAt)||
          wall<captured.observedAt||monotonic<captured.observedMonotonic||
          wall<lastWall||monotonic<lastMonotonic||
          monotonic-captured.observedMonotonic>=REUSE_WINDOW_MS||wall-captured.observedAt>=REUSE_WINDOW_MS||wall>=captured.expiresAt) {
          dead=true;
          return false;
        }
        lastWall=wall;
        lastMonotonic=monotonic;
        return true;
      } catch {
        dead=true;
        return false;
      }
    };
    const localValidate=async(signal:AbortSignal):Promise<boolean>=>{
      if(!valid()||signal.aborted){dead=true;return false;}
      let local=false;
      try { local=await captured.validateLocal(signal); } catch { local=false; }
      if(!local||signal.aborted||!valid()){dead=true;return false;}
      return true;
    };
    const proof=Object.freeze({
      validate:localValidate,
      valid,
    } satisfies SessionAccountProof);
    return Object.freeze({
      claim:async(signal:AbortSignal):Promise<SessionAccountProof|null>=>{
        if(consumed||dead||issuedGeneration!==generation)return null;
        consumed=true;
        return await localValidate(signal)?proof:null;
      },
      invalidate,
    } satisfies SessionAccountReuse);
  };

  return {
    issue,
    invalidate:()=>{generation++;},
  };
}
