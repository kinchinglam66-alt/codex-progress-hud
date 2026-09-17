import {expect,it} from 'vitest';
import * as options from '../../src/evaluation/native-comparison-options.js';
const evidence={comparison:{gate:{passed:false},splitGate:{version:'native-context-split-v2',passed:true}},
 lifecycleCost:{complete:true,nonIncreasing:true},cleanupConfirmed:true,performanceEligible:true,errors:[] as string[]};
it('requires explicit v3 selection and its own gate, while preserving lifecycle checks',()=>{
 expect(options.nativeComparisonOptions('--run-reuse-completed-1m',['--split-usage-report'])).toMatchObject({acceptanceVersion:'split-v3'});
 expect(()=>options.nativeComparisonOptions('--run-reuse-completed-1m',['--split-acceptance','--split-usage-report'])).toThrow();
 expect(()=>options.nativeComparisonOptions('--diagnose-native',['--split-usage-report'])).toThrow();
 const e={...evidence,comparison:{...evidence.comparison,splitUsageGate:{version:'native-context-split-v3',passed:true}},
  accounting:{starts:13,activeStarts:13,inFlight:0,unresolved:0,knownTokens:900,unknown:7,poisoned:false},
  budget:{eta:6,compaction:7,inFlight:false,stopped:false}};
 expect(options.comparisonCandidatePassed('split-v3',e)).toBe(true);
 expect(options.comparisonCandidatePassed('split-v3',evidence)).toBe(false);
 expect(options.comparisonCandidatePassed('split-v3',{...e,lifecycleCost:{complete:false,nonIncreasing:true}})).toBe(false);
 expect(options.comparisonCandidatePassed('split-v3',{...e,cleanupConfirmed:false})).toBe(false);
 for(const patch of [
  {accounting:undefined},{budget:undefined},
  {accounting:{...e.accounting,inFlight:1}},{accounting:{...e.accounting,unresolved:1}},
  {accounting:{...e.accounting,poisoned:true}},{accounting:{...e.accounting,unknown:NaN}},
  {budget:{...e.budget,inFlight:true}},{budget:{...e.budget,stopped:true}},
  {budget:{...e.budget,eta:5}},{budget:{...e.budget,compaction:NaN}},
 ])expect(options.comparisonCandidatePassed('split-v3',{...e,...patch})).toBe(false);
});
it('selects the registered gate without fallback or ignoring lifecycle failure',()=>{
 expect(options).toHaveProperty('comparisonCandidatePassed');
 const assess=options.comparisonCandidatePassed;
 expect(assess('legacy-v1',evidence)).toBe(false);
 expect(assess('split-v2',evidence)).toBe(true);
 for(const patch of [
  {comparison:{}},{comparison:{gate:{passed:true}}},
  {comparison:{...evidence.comparison,splitGate:{version:'wrong',passed:true}}},
  {lifecycleCost:{complete:false,nonIncreasing:true}},
  {lifecycleCost:{complete:true,nonIncreasing:false}},
  {cleanupConfirmed:false},{performanceEligible:false},{errors:['failed']},
 ])expect(assess('split-v2',{...evidence,...patch})).toBe(false);
 expect(assess('unknown' as never,evidence)).toBe(false);
});
