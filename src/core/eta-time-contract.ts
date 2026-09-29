import {z} from 'zod';
import {ETA_TIME_BASIS} from './eta-time-basis.js';
export {ETA_TIME_BASIS} from './eta-time-basis.js';

/** New predictions only. Never reinterpret legacy activeSeconds as this clock. */
const time = z.number().finite().nonnegative();
const refs = z.array(z.string().min(1)).min(1);
const segmentSchema = z.object({
  startMs: time, endMs: time,
  kind: z.enum(['system_or_running', 'confirmed_human_block', 'blocking_unknown', 'recording_gap']),
  evidenceRefs: refs,
  // Deduction requires affirmative evidence of BOTH human ownership and whole-turn blockage.
  humanActionRequired: z.boolean().optional(),
  wholeTurnBlocked: z.boolean().optional(),
  relevantWorkRunning: z.boolean().optional(),
}).strict().superRefine((s, ctx) => {
  if (s.endMs <= s.startMs) ctx.addIssue({code:'custom', message:'nonpositive_segment'});
  if (s.kind === 'confirmed_human_block' &&
      (s.humanActionRequired !== true || s.wholeTurnBlocked !== true || s.relevantWorkRunning !== false))
    ctx.addIssue({code:'custom', message:'human_block_not_proven'});
});

export const etaTimelineSchema = z.object({
  basis: z.literal(ETA_TIME_BASIS), threadId: z.string().min(1), turnId: z.string().min(1),
  startMs: time, endMs: time,
  outcome: z.enum(['running', 'completed', 'interrupted', 'failed', 'unknown']),
  // Verified by the native-event adapter, not by the estimating model.
  clockVerified: z.boolean(), boundaryEvidenceRefs: refs,
  segments: z.array(segmentSchema),
}).strict().superRefine((t, ctx) => {
  if (t.endMs < t.startMs) ctx.addIssue({code:'custom', message:'reversed_timeline'});
  let cursor = t.startMs;
  for (const s of t.segments) {
    if (s.startMs !== cursor) ctx.addIssue({code:'custom', message:'non_partitioned_timeline'});
    cursor = s.endMs;
  }
  if (cursor !== t.endMs) ctx.addIssue({code:'custom', message:'incomplete_timeline'});
});
export type EtaTimeline = z.infer<typeof etaTimelineSchema>;

/** System waits and unresolved approval overlap remain in the central clock.
 * Unknown/gap intervals block primary scoring; bounds are sensitivity only. */
export function measureEtaWindow(raw: unknown, fromMs: number, toMs: number) {
  const t = etaTimelineSchema.parse(raw);
  if (![fromMs,toMs].every(Number.isFinite) || fromMs < t.startMs || toMs > t.endMs || toMs < fromMs)
    throw new Error('window_outside_timeline');
  let excludedMs = 0, unknownMs = 0, gapMs = 0;
  for (const s of t.segments) {
    const overlap = Math.max(0, Math.min(toMs,s.endMs)-Math.max(fromMs,s.startMs));
    if (s.kind === 'confirmed_human_block') excludedMs += overlap;
    if (s.kind === 'blocking_unknown') unknownMs += overlap;
    if (s.kind === 'recording_gap') gapMs += overlap;
  }
  const grossSeconds = (toMs-fromMs)/1000;
  const seconds = grossSeconds-excludedMs/1000;
  return {basis: ETA_TIME_BASIS, grossSeconds, seconds, excludedHumanSeconds:excludedMs/1000,
    unknownBlockingSeconds:unknownMs/1000, recordingGapSeconds:gapMs/1000,
    reliable:t.clockVerified && unknownMs === 0 && gapMs === 0,
    sensitivityBounds:t.clockVerified && gapMs === 0 ?
      {lowerSeconds:seconds-unknownMs/1000, upperSeconds:seconds} : null};
}

/** Shared candidate countdown primitive, not yet wired to production UI. */
export function projectWallCountdown(raw: unknown, anchorMs: number, nowMs: number, remainingSeconds: number) {
  if (!Number.isFinite(remainingSeconds) || remainingSeconds < 0) throw new Error('invalid_prediction');
  const elapsed = measureEtaWindow(raw,anchorMs,nowMs);
  return {remainingSeconds:Math.max(0,remainingSeconds-elapsed.seconds),
    timingUncertain:!elapsed.reliable, elapsed};
}
