import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {afterEach,expect,it} from 'vitest';
import {createResidualRuntime} from '../../../src/estimation/residual/runtime.js';
import {readResidualSegments} from '../../../src/estimation/residual/recorder.js';
import {buildDataset} from '../../../src/evaluation/residual/dataset.js';
const roots:string[]=[];afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
const owner={sessionKey:'private-session',turnKey:'private-turn',sourceEpoch:1,generation:1};
const actions={outstandingActions:0,completedActions:0,failedActions:0,oldestActionActiveSeconds:0,prefixComplete:true};
const versions={input:'i',prompt:'p',model:'m',algorithm:'a'};
it('records an accepted raw forecast and independent terminal without a model artifact',async()=>{
  const p=await mkdtemp(join(tmpdir(),'residual-runtime-'));roots.push(p);const runtime=await createResidualRuntime(p);
  const ticket=runtime.capture(owner,1,'watermark',30,actions);
  runtime.accept(ticket,60,35,versions);
  runtime.boundary({...owner,activeSeconds:70,state:'waiting',trusted:true,outcome:'normal_end',evidenceId:'terminal'});
  await runtime.close();
  const records=(await readResidualSegments(p)).records;
  expect(buildDataset(records).samples[0]).toMatchObject({actualSeconds:40,deliveryLagSeconds:5});
  expect(JSON.stringify(records)).not.toContain('private-');
});
it('records unavailable accepted prefixes for coverage instead of dropping them',async()=>{
  const p=await mkdtemp(join(tmpdir(),'residual-runtime-'));roots.push(p);const runtime=await createResidualRuntime(p);
  runtime.unavailable(owner,1,60,35,versions);
  runtime.unavailable(owner,2,60,35,versions,'unknown_attribution');
  await runtime.close();
  const result=buildDataset((await readResidualSegments(p)).records);
  expect(result.attempts).toHaveLength(2);expect(result.attempts[0]?.reason).toBe('prefix_unavailable');
  expect(result.attempts[0]).not.toHaveProperty('detail');
  expect(result.attempts[1]).toMatchObject({reason:'prefix_unavailable',detail:'unknown_attribution'});
});
it('rejects old conversation ownership and duplicate settlement',async()=>{
  const p=await mkdtemp(join(tmpdir(),'residual-runtime-'));roots.push(p);const runtime=await createResidualRuntime(p);
  const stale=runtime.capture(owner,1,'watermark',30,actions);
  const next={...owner,turnKey:'next'};runtime.capture(next,2,'watermark2',0,actions);
  runtime.accept(stale,60,35,versions);runtime.accept(stale,60,35,versions);
  await runtime.close();expect((await readResidualSegments(p)).records.filter(r=>r.kind==='forecast')).toEqual([]);
});
it('uses actual generations and releases forgotten owners before late settlement',async()=>{
  const p=await mkdtemp(join(tmpdir(),'residual-runtime-'));roots.push(p);const runtime=await createResidualRuntime(p);
  const stale=runtime.capture(owner,1,'watermark',30,actions);
  const next={...owner,generation:2},fresh=runtime.capture(next,2,'watermark2',0,actions);
  expect(runtime.accept(stale,60,35,versions)).toBe(false);
  expect(runtime.accept(fresh,60,5,versions)).toBe(true);
  const detached=runtime.capture(next,3,'watermark3',6,actions);runtime.forget(owner.sessionKey);
  expect(runtime.accept(detached,60,7,versions)).toBe(false);
  await runtime.close();const records=(await readResidualSegments(p)).records;
  expect(records.find(r=>r.kind==='forecast')).toMatchObject({prefix:{identity:{generation:2}}});
  expect(buildDataset(records).samples).toEqual([]);
});
