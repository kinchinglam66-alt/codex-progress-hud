import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {createResidualRecorder,readResidualSegments} from '../../../src/estimation/residual/recorder.js';
const roots:string[]=[];
afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
async function root(){const p=await mkdtemp(join(tmpdir(),'residual-test-'));roots.push(p);return p;}
it('persists anonymous identities and stores no source text',async()=>{
  const p=await root(),r=await createResidualRecorder(p),ids=r.identify('secret-host','secret-chat','secret-turn');
  r.record({schemaVersion:1,kind:'invalidate',sequence:1,identity:{...ids,runId:'a'.repeat(32),sourceEpoch:1,generation:1},reason:'clock_unknown'});
  await r.close();
  const next=await createResidualRecorder(p);
  expect(next.identify('secret-host','secret-chat','secret-turn')).toEqual(ids);
  expect(next.identify('other-host','secret-chat','secret-turn').groupId).not.toBe(ids.groupId);
  await next.close();
  for(const f of await readdir(p))expect(await readFile(join(p,f),'utf8')).not.toContain('secret-');
  expect((await readResidualSegments(p)).records).toHaveLength(1);
});
it('bounds queue overflow and refuses to use an incomplete segment as evidence',async()=>{
  const p=await root(),r=await createResidualRecorder(p),identity={...r.identify('h','c','t'),runId:'a'.repeat(32),sourceEpoch:1,generation:1};
  for(let sequence=1;sequence<=300;sequence++)r.record({schemaVersion:1,kind:'invalidate',sequence,identity,reason:'clock_unknown'});
  await r.close();expect(r.status().dropped).toBeGreaterThan(0);
  const data=await readResidualSegments(p);expect(data.records).toEqual([]);expect(data.excluded.recording_gap).toBeGreaterThan(0);
});
it('does not leak invalid records or throw into the caller',async()=>{
  const p=await root(),r=await createResidualRecorder(p);
  expect(()=>r.record({text:'secret'} as never)).not.toThrow();await r.close();
  expect(r.status().dropped).toBe(1);
  expect(()=>r.record({} as never)).not.toThrow();
});
