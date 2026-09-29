import {z} from 'zod';
import {ETA_TIME_BASIS,etaTimelineSchema,type EtaTimeline} from './eta-time-contract.js';

const ms=z.number().int().nonnegative().safe();
const ref=z.string().min(1).max(256);
const eventSchema=z.object({
  threadId:ref,turnId:ref,streamId:ref,sequence:ms.positive(),
  monoMs:ms,wallMs:ms,evidenceRef:ref,
  kind:z.enum(['start','state','terminal','disconnect','reconnect']),
  state:z.enum(['system_or_running','confirmed_human_block','blocking_unknown']).optional(),
  // These attestations come from the native/controller adapter, never ETA output.
  humanActionRequired:z.boolean().optional(),wholeTurnBlocked:z.boolean().optional(),
  relevantWorkRunning:z.boolean().optional(),
  outcome:z.enum(['completed','interrupted','failed']).optional(),
  finalReplyDelivered:z.boolean().optional(),
}).strict().superRefine((e,ctx)=>{
  if(e.kind==='state'&&!e.state)ctx.addIssue({code:'custom',message:'missing_state'});
  if(e.kind==='terminal'&&!e.outcome)ctx.addIssue({code:'custom',message:'missing_outcome'});
  if(e.state==='confirmed_human_block'&&
    (e.humanActionRequired!==true||e.wholeTurnBlocked!==true||e.relevantWorkRunning!==false))
    ctx.addIssue({code:'custom',message:'human_block_not_proven'});
});
export type NativeEtaClockEvent=z.infer<typeof eventSchema>;
type State=EtaTimeline['segments'][number]['kind'];

/** Stateful adapter target for validated native/controller events. The stream
 * must provide a complete approval/blockage feed; task_started/task_complete
 * history alone cannot certify that feed. No model verdict controls this clock.
 * Full snapshots are private evidence; production model/UI should receive only
 * a bounded projection, not source identities or the event journal. */
export class NativeEtaClock {
  private readonly timeline:EtaTimeline;
  private last:NativeEtaClockEvent|null=null;
  private lastFingerprint:string|null=null;
  private state:State='system_or_running';
  private stateRef:string;
  private disconnected=false;
  private sealed=false;
  private problems=new Set<string>();
  private streams=new Set<string>();
  constructor(private readonly binding:{threadId:string;turnId:string;approvalFeedComplete:boolean},start:unknown){
    const e=eventSchema.parse(start);
    if(e.kind!=='start'||e.sequence!==1||e.threadId!==binding.threadId||e.turnId!==binding.turnId)
      throw Error('invalid_native_clock_start');
    this.stateRef=e.evidenceRef;
    this.timeline={basis:ETA_TIME_BASIS,threadId:binding.threadId,turnId:binding.turnId,
      startMs:e.wallMs,endMs:e.wallMs,outcome:'running',clockVerified:binding.approvalFeedComplete,
      boundaryEvidenceRefs:[e.evidenceRef],segments:[]};
    if(!binding.approvalFeedComplete)this.problems.add('approval_feed_incomplete');
    this.last=e;this.lastFingerprint=JSON.stringify(e);
    this.streams.add(e.streamId);
  }

  /** Exact last-event retransmission is idempotent; conflicting/reordered events
   * are refused. An explicit reconnect is required for a new process clock. */
  accept(raw:unknown):'accepted'|'duplicate'{
    const e=eventSchema.parse(raw),prior=this.last!;
    if(e.threadId!==this.binding.threadId||e.turnId!==this.binding.turnId)throw Error('clock_binding_mismatch');
    const fingerprint=JSON.stringify(e);
    if(e.streamId===prior.streamId&&e.sequence===prior.sequence){
      if(fingerprint===this.lastFingerprint)return 'duplicate';
      throw Error('conflicting_clock_event');
    }
    if(this.sealed)throw Error('clock_already_terminal');
    const newStream=e.streamId!==prior.streamId;
    if(newStream&&this.streams.has(e.streamId))throw Error('reused_clock_stream');
    if(newStream&&e.kind!=='reconnect')throw Error('unannounced_clock_restart');
    if((!newStream&&e.sequence<=prior.sequence)||(newStream&&e.sequence!==1))throw Error('clock_event_order');
    if(e.kind==='start')throw Error('duplicate_turn_start');
    if(e.wallMs<prior.wallMs||(!newStream&&e.monoMs<prior.monoMs))throw Error('clock_reversed');
    if(e.kind==='reconnect'&&!this.disconnected&&!newStream)throw Error('unexpected_reconnect');
    const sequenceGap=!newStream&&e.sequence!==prior.sequence+1;
    const clockJump=!newStream&&Math.abs((e.wallMs-prior.wallMs)-(e.monoMs-prior.monoMs))>1000;
    if(sequenceGap)this.problems.add('event_sequence_gap');
    if(clockJump)this.problems.add('wall_clock_jump');
    if(newStream)this.problems.add('recorder_restart');
    this.streams.add(e.streamId);
    const gap=this.disconnected||newStream||sequenceGap||clockJump;
    if(e.wallMs>prior.wallMs){
      const kind:State=gap?'recording_gap':this.state;
      this.timeline.segments.push({startMs:prior.wallMs,endMs:e.wallMs,kind,
        evidenceRefs:[this.stateRef,e.evidenceRef],...(kind==='confirmed_human_block'?{
          humanActionRequired:true,wholeTurnBlocked:true,relevantWorkRunning:false}:{})});
    }
    this.timeline.endMs=e.wallMs;
    if(sequenceGap||clockJump||newStream)this.timeline.clockVerified=false;
    if(e.kind==='disconnect'){this.disconnected=true;this.problems.add('recorder_disconnect');}
    if(e.kind==='reconnect'){
      this.disconnected=false;
      // A pre-restart human-block proof cannot be reused for a later interval.
      this.state='blocking_unknown';this.stateRef=e.evidenceRef;
    }
    if(e.kind==='state'){
      this.state=e.state!;this.stateRef=e.evidenceRef;
    }
    if(e.kind==='terminal'){
      this.sealed=true;
      this.timeline.outcome=e.outcome==='completed'&&e.finalReplyDelivered!==true?'unknown':e.outcome!;
      if(this.timeline.outcome==='unknown')this.problems.add('final_delivery_unconfirmed');
      this.timeline.boundaryEvidenceRefs.push(e.evidenceRef);
    }
    this.last=e;this.lastFingerprint=fingerprint;
    return 'accepted';
  }

  snapshot(){
    return {timeline:etaTimelineSchema.parse(structuredClone(this.timeline)),
      problems:[...this.problems],sealed:this.sealed};
  }
}

/** A pending UI prompt alone never proves that the whole turn is stopped.
 * Automated approvals count as system waits. Overlap can be identified without
 * inventing its critical-path impact; ambiguous overlap remains labelled. */
export function classifyApprovalWait(facts:{actor:'human'|'automatic'|'unknown';
  wholeTurnBlocked?:boolean;relevantWorkRunning?:boolean;impactKnown:boolean}){
  if(facts.actor==='automatic')return {state:'system_or_running' as const,blockingUnknown:false};
  if(facts.actor==='human'&&facts.impactKnown&&facts.wholeTurnBlocked===true&&facts.relevantWorkRunning===false)
    return {state:'confirmed_human_block' as const,blockingUnknown:false};
  if(facts.relevantWorkRunning===true&&facts.wholeTurnBlocked!==true&&facts.impactKnown)
    return {state:'system_or_running' as const,blockingUnknown:false};
  return {state:'blocking_unknown' as const,blockingUnknown:true};
}
