/** Diagnostic mode selection, never an inference authorization. */
export function nativeComparisonOptions(mode:string|undefined,flags:readonly string[]){
 const supported=['--preflight','--run-approved-6x6','--diagnose-native','--preflight-completed-85k','--preflight-completed-1m',
  '--run-completed-85k','--run-completed-1m','--diagnose-completed-1m','--diagnose-completed-85k',
  '--run-reuse-completed-1m','--run-reuse-completed-85k','--preflight-reuse-completed-1m','--preflight-reuse-completed-85k','--diagnose-reuse-completed-1m'];
 if(!mode||!supported.includes(mode)||flags.length>5||new Set(flags).size!==flags.length||flags.some(flag=>!['--inline-supplement','--reuse-home-check','--reuse-native-guard','--reuse-account-cache','--reuse-turn-session','--source-correction','--collect-context-failures','--split-acceptance','--split-usage-report'].includes(flag)))throw Error('EXPLICIT_SYNTHETIC_TRIAL_ARGUMENTS_REQUIRED');
 if(flags.includes('--split-acceptance')&&flags.includes('--split-usage-report'))throw Error('CONFLICTING_ACCEPTANCE_VERSIONS');
 const acceptanceVersion:ComparisonAcceptanceVersion=flags.includes('--split-usage-report')?'split-v3':flags.includes('--split-acceptance')?'split-v2':'legacy-v1';
 if(acceptanceVersion!=='legacy-v1'&&!['--run-reuse-completed-1m','--run-reuse-completed-85k','--preflight-reuse-completed-1m','--preflight-reuse-completed-85k'].includes(mode))throw Error('SPLIT_ACCEPTANCE_PAIRED_REQUIRED');
 const collectContextFailures=flags.includes('--collect-context-failures');
 if(collectContextFailures&&!['--run-reuse-completed-1m','--run-reuse-completed-85k','--preflight-reuse-completed-1m','--preflight-reuse-completed-85k'].includes(mode))throw Error('CONTEXT_COLLECTION_PAIRED_REQUIRED');
 const sourceCorrection=flags.includes('--source-correction');
 if(sourceCorrection&&!['--diagnose-completed-1m','--preflight-completed-1m'].includes(mode))throw Error('SOURCE_CORRECTION_DIAGNOSTIC_REQUIRED');
 const qualification=mode.includes('-reuse-completed-');
 const reuseNativeTurnSession=qualification||flags.includes('--reuse-turn-session');
 if(reuseNativeTurnSession&&!qualification&&!['--diagnose-completed-1m','--preflight-completed-1m'].includes(mode))throw Error('TURN_REUSE_DIAGNOSTIC_REQUIRED');
 const reuseAccountCache=flags.includes('--reuse-account-cache');
 const reuseNativeGuard=flags.includes('--reuse-native-guard');
 const completedMode=mode.includes('-completed-'),inlineSupplement=flags.includes('--inline-supplement'),reuseHomeCheckProcess=flags.includes('--reuse-home-check');
 if(inlineSupplement&&!completedMode)throw Error('INLINE_TRIAL_REQUIRES_COMPLETED_TURN');
 if(reuseHomeCheckProcess&&!completedMode)throw Error('REUSABLE_HOME_TRIAL_REQUIRES_COMPLETED_TURN');
 if(reuseNativeGuard&&!completedMode)throw Error('REUSABLE_NATIVE_GUARD_REQUIRES_COMPLETED_TURN');
 if(reuseAccountCache&&!completedMode)throw Error('ACCOUNT_CACHE_TRIAL_REQUIRES_COMPLETED_TURN');
 const sequenceDiagnostic=mode==='--diagnose-completed-1m';
 const sourceReadbackDiagnostic=mode==='--diagnose-reuse-completed-1m';
 const nativeDiagnostic=sourceReadbackDiagnostic||mode==='--diagnose-native'||sequenceDiagnostic||mode==='--diagnose-completed-85k';
 return {acceptanceVersion,completedMode,inlineSupplement,reuseHomeCheckProcess,reuseNativeGuard,reuseAccountCache,reuseNativeTurnSession,sourceCorrection,qualification,sequenceDiagnostic,nativeDiagnostic,sourceReadbackDiagnostic,collectContextFailures,readback:sequenceDiagnostic||completedMode&&nativeDiagnostic};
}

export type ComparisonAcceptanceVersion='legacy-v1'|'split-v2'|'split-v3';
export interface ComparisonAcceptanceEvidence {
 comparison?:{gate?:{passed:boolean};splitGate?:{version:string;passed:boolean};splitUsageGate?:{version:string;passed:boolean}};
 lifecycleCost?:{complete:boolean;nonIncreasing:boolean};
 cleanupConfirmed:boolean;
 performanceEligible?:boolean;
 errors:readonly string[];
 accounting?:{starts:number;activeStarts:number;inFlight:number;unresolved:number;knownTokens:number;unknown:number;poisoned:boolean}|undefined;
 budget?:{eta:number;compaction:number;inFlight:boolean;stopped:boolean}|undefined;
}
/** Select once from registered options; never fall back to whichever gate passes. */
export function comparisonCandidatePassed(version:ComparisonAcceptanceVersion,evidence:ComparisonAcceptanceEvidence):boolean {
 if(version==='split-v3'){
  const a=evidence.accounting,b=evidence.budget;
  const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  if(!a||!b||![a.starts,a.activeStarts,a.inFlight,a.unresolved,a.knownTokens,a.unknown,b.eta,b.compaction].every(count)
    ||a.inFlight!==0||a.unresolved!==0||a.poisoned!==false||b.inFlight!==false||b.stopped!==false
    ||b.eta!==6||b.compaction>24||a.activeStarts>a.starts)return false;
 }
 const gate=version==='legacy-v1'?evidence.comparison?.gate:
  version==='split-v2'&&evidence.comparison?.splitGate?.version==='native-context-split-v2'?evidence.comparison.splitGate:
  version==='split-v3'&&evidence.comparison?.splitUsageGate?.version==='native-context-split-v3'?evidence.comparison.splitUsageGate:undefined;
 return gate?.passed===true&&evidence.performanceEligible!==false&&evidence.cleanupConfirmed===true
  &&evidence.lifecycleCost?.complete===true&&evidence.lifecycleCost.nonIncreasing===true&&evidence.errors.length===0;
}
