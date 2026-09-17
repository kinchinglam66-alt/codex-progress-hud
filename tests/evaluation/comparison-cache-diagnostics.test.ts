import {expect,it} from 'vitest';
import {createComparisonCacheDiagnostics} from '../../src/evaluation/comparison-cache-diagnostics.js';
it('records bounded numeric cache evidence without copying identity or credential fields',()=>{
 const d=createComparisonCacheDiagnostics();
 d.record('history',{hitCount:1,missCount:2,localGuardCount:3,localGuardMs:4.5,secret:'do not copy'});
 expect(d.snapshot()).toEqual([{strategy:'history',hitCount:1,missCount:2,localGuardCount:3,localGuardMs:4.5}]);
 d.record('native',undefined);d.record('native',{hitCount:NaN});
 expect(d.snapshot()).toHaveLength(1);
});
it('bounds evidence and returns snapshots that cannot mutate stored counters',()=>{
 const d=createComparisonCacheDiagnostics();
 for(let i=0;i<140;i++)d.record('native',{hitCount:i,missCount:0,localGuardCount:i,localGuardMs:0});
 const snapshot=d.snapshot();expect(snapshot).toHaveLength(128);snapshot[0]!.hitCount=999;
 expect(d.snapshot()[0]!.hitCount).toBe(0);
});
