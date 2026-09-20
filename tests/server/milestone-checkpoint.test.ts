import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMilestoneCheckpointRepository} from '../../src/server/milestone-checkpoint.js';
import {createProgressState,progressScope} from '../../src/estimation/progress-state.js';
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'milestone-sidecar-'));dirs.push(directory);
 const options={directory,sourceIdentity:'source',isOwner:async()=>true,now:()=>10000};
 const record={sessionKey:'session',turnKey:'turn',sourceEpoch:1,generation:1,estimateRevision:2,savedAtMs:9000,progressState:createProgressState(progressScope('session','turn',1,0))};
 return {directory,options,record,repository:createMilestoneCheckpointRepository(options)};
}
it('round-trips separately without changing the legacy checkpoint',async()=>{
 const f=await fixture();await writeFile(join(f.directory,'goal-checkpoint.json'),'legacy');await f.repository.save([f.record]);
 expect(await f.repository.load()).toEqual([f.record]);expect(await readFile(join(f.directory,'goal-checkpoint.json'),'utf8')).toBe('legacy');
});
it('rejects owner loss without replacing saved state',async()=>{
 const f=await fixture();await f.repository.save([f.record]);
 const blocked=createMilestoneCheckpointRepository({...f.options,isOwner:async()=>false});await expect(blocked.save([])).rejects.toThrow();
 expect(await f.repository.load()).toHaveLength(1);
});
it('does not restore a different source',async()=>{const f=await fixture();await f.repository.save([f.record]);
 expect(await createMilestoneCheckpointRepository({...f.options,sourceIdentity:'other'}).load()).toEqual([]);
});
it('rejects malformed, duplicate and future records',async()=>{
 const f=await fixture();expect(()=>f.repository.save([f.record,f.record])).toThrow();
 expect(()=>f.repository.save([{...f.record,savedAtMs:10001}])).toThrow();
 await writeFile(join(f.directory,'milestone-checkpoint.json'),'{');await expect(f.repository.load()).rejects.toThrow();
});
it('rejects linked targets rather than reading or replacing them',async()=>{
 const f=await fixture();const other=join(f.directory,'other');await writeFile(other,'secret');await link(other,join(f.directory,'milestone-checkpoint.json'));
 await expect(f.repository.load()).rejects.toThrow();await expect(f.repository.save([])).rejects.toThrow();expect(await readFile(other,'utf8')).toBe('secret');
});
