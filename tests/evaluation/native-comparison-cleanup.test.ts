import {expect,it} from 'vitest';
import {closeComparisonOwners} from '../../src/evaluation/native-comparison-cleanup.js';
it('attempts every owner even after the first close fails and retains all failures',async()=>{
 const attempted:string[]=[];
 const owners=['native','history','reader','identity'].map(name=>({name,close:async()=>{attempted.push(name);if(name==='native'||name==='reader')throw Error('unconfirmed');}}));
 const result=await closeComparisonOwners(owners);
 expect(attempted).toEqual(['native','history','reader','identity']);
 expect(result.failed).toEqual(['native','reader']);expect(Object.keys(result.durationMs)).toEqual(attempted);
});
it('reports no failure only after all closures resolve',async()=>{
 const result=await closeComparisonOwners([{name:'identity',close:async()=>{}}]);
 expect(result.failed).toEqual([]);expect(result.durationMs.identity).toBeGreaterThanOrEqual(0);
});
