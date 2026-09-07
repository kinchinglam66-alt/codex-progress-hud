import {z} from 'zod';
const seconds=z.number().finite().nonnegative().max(31536000);
const identity={session:z.string().min(1),key:z.string().min(1),generation:z.number().int().nonnegative(),confirmedBy:z.literal('user')};
const labelSchema=z.discriminatedUnion('outcome',[
  z.object({...identity,outcome:z.literal('completed'),completedActiveSeconds:seconds.positive()}).strict(),
  z.object({...identity,outcome:z.literal('interrupted'),censoredActiveSeconds:seconds.optional()}).strict(),
  z.object({...identity,outcome:z.literal('replaced'),censoredActiveSeconds:seconds.optional()}).strict(),
]);
const resultSchema=z.object({session:z.string(),key:z.string(),generation:z.number().int().nonnegative(),kind:z.literal('result'),
  accepted:z.boolean(),status:z.string(),at:z.number().finite().nonnegative(),requestedAt:z.number().finite().nonnegative(),
  observedActiveSeconds:seconds,activeSeconds:seconds,
  estimate:z.object({remainingSeconds:seconds,errorPercent:z.number().finite().min(0).max(1000)}).nullable()});

/** Offline per-goal scoring. Human labels are supplied separately and are never
 * inferred from observer status. This is not cross-task calibration evidence. */
export function scorePilotGoal(records:readonly unknown[],rawLabel:unknown){
  const label=labelSchema.parse(rawLabel);
  const eligible=label.outcome==='completed';
  const attempts=records.flatMap(value=>{
    const parsed=resultSchema.safeParse(value);
    return parsed.success && parsed.data.session===label.session && parsed.data.key===label.key && parsed.data.generation===label.generation?[parsed.data]:[];
  });
  const points=eligible?attempts.flatMap(value=>{
    const estimate=value.estimate;
    if(!value.accepted || value.status!=='interpreted' || !estimate || value.at<value.requestedAt ||
      value.activeSeconds<value.observedActiveSeconds || value.observedActiveSeconds>=label.completedActiveSeconds ||
      value.activeSeconds>label.completedActiveSeconds)return [];
    const actualRemainingSeconds=label.completedActiveSeconds-value.observedActiveSeconds;
    const absoluteErrorSeconds=Math.abs(estimate.remainingSeconds-actualRemainingSeconds);
    const margin=estimate.remainingSeconds*estimate.errorPercent/100;
    const progress=value.observedActiveSeconds/label.completedActiveSeconds;
    return [{at:value.at,actualRemainingSeconds,absoluteErrorSeconds,relativeError:absoluteErrorSeconds/actualRemainingSeconds,
      covered:actualRemainingSeconds>=Math.max(0,estimate.remainingSeconds-margin) && actualRemainingSeconds<=estimate.remainingSeconds+margin,
      latencyMs:value.at-value.requestedAt,phase:progress<1/3?'early':progress<2/3?'middle':'late',
      displayedRemainingSeconds:Math.max(0,estimate.remainingSeconds-(value.activeSeconds-value.observedActiveSeconds)),
      actualRemainingAtDeliverySeconds:label.completedActiveSeconds-value.activeSeconds}];
  }):[];
  return {eligible,outcome:label.outcome,attempts:attempts.length,predictions:points.length,
    availability:eligible && attempts.length?points.length/attempts.length:null,
    meanAbsoluteErrorSeconds:points.length?points.reduce((sum,p)=>sum+p.absoluteErrorSeconds,0)/points.length:null,
    meanRelativeError:points.length?points.reduce((sum,p)=>sum+p.relativeError,0)/points.length:null,
    coverage:points.length?points.filter(p=>p.covered).length/points.length:null,points};
}
