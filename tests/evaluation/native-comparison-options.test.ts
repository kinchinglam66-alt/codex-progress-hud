import {expect,it} from 'vitest';
import {nativeComparisonOptions} from '../../src/evaluation/native-comparison-options.js';
it('selects split v2 explicitly only for paired reuse qualification and keeps legacy default',()=>{
 expect(nativeComparisonOptions('--run-reuse-completed-1m',[])).toMatchObject({acceptanceVersion:'legacy-v1'});
 for(const size of ['1m','85k'])for(const phase of ['run','preflight'])
  expect(nativeComparisonOptions(`--${phase}-reuse-completed-${size}`,['--split-acceptance'])).toMatchObject({acceptanceVersion:'split-v2'});
 for(const mode of ['--diagnose-reuse-completed-1m','--run-completed-1m','--diagnose-native'])
  expect(()=>nativeComparisonOptions(mode,['--split-acceptance'])).toThrow();
 expect(()=>nativeComparisonOptions('--run-reuse-completed-1m',['--split-acceptance','--split-acceptance'])).toThrow();
});
it('permits explicit content-failure collection only in paired reuse qualification modes',()=>{
 expect(nativeComparisonOptions('--run-reuse-completed-1m',['--collect-context-failures'])).toMatchObject({collectContextFailures:true,nativeDiagnostic:false});
 expect(nativeComparisonOptions('--preflight-reuse-completed-1m',['--collect-context-failures'])).toMatchObject({collectContextFailures:true});
 expect(nativeComparisonOptions('--run-reuse-completed-1m',[])).toMatchObject({collectContextFailures:false});
 for(const mode of ['--diagnose-reuse-completed-1m','--run-completed-1m','--diagnose-native'])expect(()=>nativeComparisonOptions(mode,['--collect-context-failures'])).toThrow();
});
it('limits qualification-fixture readback to a single native observation, not paired performance evidence',()=>{
 expect(nativeComparisonOptions('--diagnose-reuse-completed-1m',[])).toMatchObject({qualification:true,reuseNativeTurnSession:true,
  nativeDiagnostic:true,sequenceDiagnostic:false,readback:true,sourceReadbackDiagnostic:true});
 expect(nativeComparisonOptions('--run-reuse-completed-1m',[])).toMatchObject({nativeDiagnostic:false,sourceReadbackDiagnostic:false});
 expect(nativeComparisonOptions('--diagnose-reuse-completed-1m',['--inline-supplement'])).toMatchObject({reuseNativeTurnSession:true,inlineSupplement:true});
 expect(()=>nativeComparisonOptions('--diagnose-reuse-completed-1m',['--source-correction'])).toThrow();
});
it.each(['1m','85k'])('runs reuse qualification as paired, not a native-only diagnostic (%s)',size=>{
 const mode=`--run-reuse-completed-${size}`;
 expect(nativeComparisonOptions(mode,['--reuse-home-check','--reuse-native-guard'])).toMatchObject({qualification:true,reuseNativeTurnSession:true,completedMode:true,nativeDiagnostic:false,readback:false});
 expect(nativeComparisonOptions(`--preflight-reuse-completed-${size}`,[])).toMatchObject({qualification:true,reuseNativeTurnSession:true});
 expect(nativeComparisonOptions(mode,['--inline-supplement'])).toMatchObject({reuseNativeTurnSession:true,inlineSupplement:true});
 expect(()=>nativeComparisonOptions(mode,['--source-correction'])).toThrow();
 expect(nativeComparisonOptions('--run-completed-1m',[])).toMatchObject({qualification:false});
});
it('keeps source corrections diagnostic-only with an unchanged default fixture',()=>{
 expect(nativeComparisonOptions('--diagnose-completed-1m',[])).toMatchObject({sourceCorrection:false});
 expect(nativeComparisonOptions('--diagnose-completed-1m',['--source-correction','--reuse-turn-session','--reuse-home-check','--reuse-native-guard'])).toMatchObject({sourceCorrection:true,reuseNativeTurnSession:true});
 expect(nativeComparisonOptions('--preflight-completed-1m',['--source-correction'])).toMatchObject({sourceCorrection:true});
 for(const mode of ['--run-completed-1m','--diagnose-native','--diagnose-completed-85k'])expect(()=>nativeComparisonOptions(mode,['--source-correction'])).toThrow();
});
it('restricts turn-session reuse to explicit completed diagnostics',()=>{
 expect(nativeComparisonOptions('--diagnose-completed-1m',['--reuse-turn-session'])).toMatchObject({reuseNativeTurnSession:true});
 expect(nativeComparisonOptions('--run-completed-1m',[])).toMatchObject({reuseNativeTurnSession:false});
 for(const mode of ['--run-approved-6x6','--run-completed-1m'])expect(()=>nativeComparisonOptions(mode,['--reuse-turn-session'])).toThrow();
 expect(nativeComparisonOptions('--diagnose-completed-1m',['--reuse-turn-session','--inline-supplement'])).toMatchObject({reuseNativeTurnSession:true,inlineSupplement:true});
});
it('requires explicit account cache opt-in and preserves the bypass baseline',()=>{
 expect(nativeComparisonOptions('--run-completed-85k',[])).toMatchObject({reuseAccountCache:false});
 expect(nativeComparisonOptions('--run-completed-85k',['--reuse-account-cache','--reuse-native-guard','--reuse-home-check','--inline-supplement'])).toMatchObject({reuseAccountCache:true});
 expect(()=>nativeComparisonOptions('--run-approved-6x6',['--reuse-account-cache'])).toThrow();
 expect(()=>nativeComparisonOptions('--run-completed-85k',['--reuse-account-cache','--reuse-account-cache'])).toThrow();
});
it('enables native guard reuse only in explicit completed-turn trials',()=>{
 expect(nativeComparisonOptions('--run-completed-85k',[])).toMatchObject({reuseNativeGuard:false});
 expect(nativeComparisonOptions('--run-completed-85k',['--reuse-native-guard','--reuse-home-check','--inline-supplement'])).toMatchObject({reuseNativeGuard:true,reuseHomeCheckProcess:true,inlineSupplement:true});
 expect(()=>nativeComparisonOptions('--run-approved-6x6',['--reuse-native-guard'])).toThrow();
 expect(()=>nativeComparisonOptions('--run-completed-85k',['--reuse-native-guard','--reuse-native-guard'])).toThrow();
});
it('keeps inline supplementation opt-in and restricted to completed-turn experiments',()=>{
 expect(nativeComparisonOptions('--run-completed-85k',[])).toMatchObject({inlineSupplement:false,nativeDiagnostic:false,readback:false});
 expect(nativeComparisonOptions('--run-completed-85k',['--inline-supplement'])).toMatchObject({inlineSupplement:true,readback:false});
 expect(nativeComparisonOptions('--diagnose-completed-85k',['--inline-supplement'])).toMatchObject({nativeDiagnostic:true,sequenceDiagnostic:false,readback:true});
 expect(nativeComparisonOptions('--diagnose-completed-1m',['--inline-supplement'])).toMatchObject({nativeDiagnostic:true,sequenceDiagnostic:true,readback:true});
 for(const args of [['--inline-supplement','--inline-supplement'],['--unknown']])expect(()=>nativeComparisonOptions('--run-completed-85k',args)).toThrow();
 expect(()=>nativeComparisonOptions('--run-approved-6x6',['--inline-supplement'])).toThrow();
 expect(()=>nativeComparisonOptions('--unknown',[])).toThrow();
});
it('requires explicit reusable-home opt-in and supports independent inline supplementation',()=>{
 expect(nativeComparisonOptions('--run-completed-85k',[])).toMatchObject({reuseHomeCheckProcess:false});
 expect(nativeComparisonOptions('--run-completed-85k',['--reuse-home-check','--inline-supplement'])).toMatchObject({reuseHomeCheckProcess:true,inlineSupplement:true});
 expect(nativeComparisonOptions('--preflight-completed-1m',['--reuse-home-check'])).toMatchObject({reuseHomeCheckProcess:true,inlineSupplement:false});
 expect(()=>nativeComparisonOptions('--run-completed-85k',['--reuse-home-check','--reuse-home-check'])).toThrow();
 expect(()=>nativeComparisonOptions('--run-approved-6x6',['--reuse-home-check'])).toThrow();
});
