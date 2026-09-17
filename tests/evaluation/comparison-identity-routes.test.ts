import {expect,it} from 'vitest';
import {createComparisonIdentityRoutes} from '../../src/evaluation/comparison-identity-routes.js';
import {closeComparisonOwners} from '../../src/evaluation/native-comparison-cleanup.js';
function fixture(enabled=true){
 const calls:string[]=[],closed:string[]=[];let next=0;
 const create=(name:string)=>({
  async prepareSession(_s:AbortSignal,p:{accountCache:'allow'|'bypass'}){calls.push(`${name}:${p.accountCache}`);return name;},
  invalidateSessionReuse(){calls.push(`${name}:invalidate`);},
  async close(){closed.push(name);if(name==='1')throw Error('close failed');},
 });
 const seed=create('seed');
 const routes=createComparisonIdentityRoutes({enabled,seed,create:()=>create(String(++next))});
 return {routes,calls,closed};
}
const signal=()=>new AbortController().signal;
it('uses separate cold identities and keeps the seed out of both strategy caches',async()=>{
 const {routes,calls}=fixture();
 expect(await routes.prepare(signal())).toBe('seed');
 expect(await routes.prepare(signal(),'history')).toBe('1');
 expect(await routes.prepare(signal(),'native')).toBe('2');
 expect(await routes.prepare(signal(),'history')).toBe('1');
 expect(calls).toEqual(['seed:bypass','1:allow','2:allow','1:allow']);
});
it('honors forced bypass and routes invalidation only to the selected identity',async()=>{
 const {routes,calls}=fixture();
 await routes.prepare(signal(),'native',{accountCache:'bypass'});
 routes.identity('native').invalidateSessionReuse();
 expect(calls).toEqual(['1:bypass','1:invalidate']);
});
it('keeps legacy bypass behavior and rejects invalid strategies even without opt-in',async()=>{
 const {routes,calls}=fixture(false);
 await routes.prepare(signal(),'history',{accountCache:'allow'});
 await routes.prepare(signal(),'native');
 expect(calls).toEqual(['seed:bypass','seed:bypass']);
 expect(()=>routes.identity('wrong' as 'native')).toThrow('TRIAL_STRATEGY_INVALID');
 expect(routes.owners()).toHaveLength(0);
});
it('exposes every created owner so one close failure does not skip the other',async()=>{
 const {routes,closed}=fixture();
 await routes.prepare(signal(),'history');await routes.prepare(signal(),'native');
 const result=await closeComparisonOwners(routes.owners());
 expect(closed).toEqual(['1','2']);expect(result.failed).toEqual(['identity-history']);
});
