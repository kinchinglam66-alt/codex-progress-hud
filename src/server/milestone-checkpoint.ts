import {z} from 'zod';
import {progressStateSchema} from '../estimation/progress-state.js';
import {createMilestoneCheckpointStorage} from './goal-checkpoint.js';
const integer=z.number().int().nonnegative().safe();
export const milestoneCheckpointRecordSchema=z.object({sessionKey:z.string().min(1).max(256),turnKey:z.string().min(1).max(256),
  sourceEpoch:integer,generation:integer,estimateRevision:integer,savedAtMs:integer,progressState:progressStateSchema}).strict();
export type MilestoneCheckpointRecord=z.infer<typeof milestoneCheckpointRecordSchema>;
const documentSchema=z.object({schemaVersion:z.literal(1),sourceIdentity:z.string().min(1).max(256),records:z.array(milestoneCheckpointRecordSchema).max(256)}).strict();
export function createMilestoneCheckpointRepository(options:{directory:string;sourceIdentity:string;isOwner:()=>Promise<boolean>;now?:()=>number}){
  const storage=createMilestoneCheckpointStorage(options),now=options.now??Date.now;
  const validate=(records:readonly MilestoneCheckpointRecord[])=>{
    const parsed=documentSchema.parse({schemaVersion:1,sourceIdentity:options.sourceIdentity,records}).records;
    for(const r of parsed)r.progressState.operations=r.progressState.operations.map(o=>({...o,description:''}));
    const keys=new Set<string>();
    for(const r of parsed){if(keys.has(r.sessionKey)||r.savedAtMs>now())throw Error('MILESTONE_CHECKPOINT_INVALID');keys.add(r.sessionKey);}
    return parsed;
  };
  return {
    async load(){const text=await storage.load();if(text===null)return [];
      const document=documentSchema.parse(JSON.parse(text));if(document.sourceIdentity!==options.sourceIdentity)return [];
      return validate(document.records).filter(r=>now()-r.savedAtMs<=7*86400000);
    },
    save(records:readonly MilestoneCheckpointRecord[]){return storage.save(JSON.stringify({schemaVersion:1,sourceIdentity:options.sourceIdentity,records:validate(records)})+'\n');},
  };
}
