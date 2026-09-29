import {z} from 'zod';
import {ETA_TIME_BASIS, etaTimelineSchema, measureEtaWindow} from '../core/eta-time-contract.js';

const time = z.number().finite().nonnegative();
const predictionSchema = z.object({
  basis:z.literal(ETA_TIME_BASIS), predictionId:z.string().min(1),
  threadId:z.string().min(1), turnId:z.string().min(1),
  anchorMs:time, deliveredAtMs:time, remainingSeconds:time.nullable(),
  // Actual recorded display value; never silently substitute simulated countdown.
  displayedRemainingSeconds:time.nullable(), deliveryEvidenceRefs:z.array(z.string().min(1)).min(1),
}).strict();

/** Pure candidate scorer. Caller must verify native evidence and audit separately.
 * Does not load, mutate or relabel legacy journals, and never infers task success. */
export function scoreWallClockPrediction(rawTimeline:unknown, rawPrediction:unknown) {
  const t=etaTimelineSchema.parse(rawTimeline), p=predictionSchema.parse(rawPrediction);
  const reasons:string[]=[];
  if (p.threadId!==t.threadId || p.turnId!==t.turnId) reasons.push('binding_mismatch');
  if (t.outcome!=='completed') reasons.push('not_normal_completion');
  if (!t.clockVerified) reasons.push('clock_unverified');
  if (p.anchorMs<t.startMs || p.anchorMs>p.deliveredAtMs || p.deliveredAtMs>=t.endMs)
    reasons.push('invalid_or_late_anchor_delivery');
  if (p.remainingSeconds===null) reasons.push('no_numeric_prediction');
  if (p.displayedRemainingSeconds===null) reasons.push('display_value_unknown');
  const result={basis:ETA_TIME_BASIS,predictionId:p.predictionId,outcome:t.outcome,
    primaryEligible:false,reasons,anchor:null as null|ReturnType<typeof error>,
    delivery:null as null|ReturnType<typeof error>,
    observedLatencySeconds:(p.deliveredAtMs-p.anchorMs)/1000,
    sensitivity:null as null|{anchor:ReturnType<typeof measureEtaWindow>;delivery:ReturnType<typeof measureEtaWindow>}};
  if (reasons.some(r=>['binding_mismatch','not_normal_completion','invalid_or_late_anchor_delivery'].includes(r))) return result;
  const anchor=measureEtaWindow(t,p.anchorMs,t.endMs), delivery=measureEtaWindow(t,p.deliveredAtMs,t.endMs);
  // Also check preparation/delivery span: uncertain subtraction cannot be repaired by a clean suffix.
  if (!anchor.reliable) reasons.push('blocking_or_recording_uncertain');
  result.sensitivity={anchor,delivery};
  if (reasons.length) return result;
  result.primaryEligible=true;
  result.anchor=error(p.remainingSeconds!,anchor.seconds);
  result.delivery=error(p.displayedRemainingSeconds!,delivery.seconds);
  return result;
}

function error(predicted:number, actual:number) {
  const signedErrorSeconds=predicted-actual;
  return {predictedSeconds:predicted, actualRemainingSeconds:actual,
    signedErrorSeconds, absoluteErrorSeconds:Math.abs(signedErrorSeconds),
    relativeError:actual>=60 ? Math.abs(signedErrorSeconds)/actual : null,
    shortRemaining:actual<60};
}
