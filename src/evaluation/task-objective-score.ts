import {z} from 'zod';
import {TASK_OBJECTIVE_TARGET} from '../core/task-objective.js';
import {scoreWallClockPrediction} from './wall-clock-score.js';

const certificate=z.object({predictionTarget:z.literal(TASK_OBJECTIVE_TARGET),
  threadId:z.string().min(1),turnId:z.string().min(1),targetId:z.string().min(1),
  controller:z.literal('independent_controller'),verdict:z.enum(['achieved','not_achieved','unknown']),
  evidenceRefs:z.array(z.string().trim().min(1)),achievedAtMs:z.number().finite().nonnegative().nullable()}).strict();
/** Separate entry: never relabel a turn-delivery score as objective accuracy.
 * References require independent review, not merely syntactically valid strings. */
export function scoreTaskObjectivePrediction(timeline:unknown,prediction:unknown,rawCertificate:unknown){
  const c=certificate.parse(rawCertificate);
  const p=z.object({predictionTarget:z.literal(TASK_OBJECTIVE_TARGET),targetId:z.string().min(1)}).passthrough().parse(prediction);
  const t=z.object({threadId:z.string(),turnId:z.string(),endMs:z.number()}).passthrough().parse(timeline);
  const reasons:string[]=[];
  if(c.threadId!==t.threadId||c.turnId!==t.turnId||c.targetId!==p.targetId)reasons.push('objective_binding_mismatch');
  if(c.verdict!=='achieved'||c.evidenceRefs.length===0||c.achievedAtMs!==t.endMs)reasons.push('objective_achievement_unverified');
  if(reasons.length)return {predictionTarget:TASK_OBJECTIVE_TARGET,primaryEligible:false,reasons,score:null};
  const {predictionTarget:_target,targetId:_id,...clockPrediction}=p;
  const score=scoreWallClockPrediction(timeline,clockPrediction);
  // A supplied reference string is not a verified certificate. Until the native
  // evidence verifier is integrated, expose arithmetic for diagnostics only.
  return {predictionTarget:TASK_OBJECTIVE_TARGET,primaryEligible:false,
    reasons:[...score.reasons,'objective_evidence_not_independently_verified'],score:{...score,primaryEligible:false}};
}
