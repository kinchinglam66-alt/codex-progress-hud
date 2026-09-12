import {identityKey,parseResearchRecord,type Identity,type Outcome,type ResearchRecord} from './contract.js';

export interface ResearchTransition {
  id:string;atActiveSeconds:number;state:'running'|'waiting'|'paused'|'unknown';outcome?:Outcome;trusted:boolean;
}
interface State {last:number;reliable:boolean;terminal?:{outcome:Outcome;at:number};invalidated:boolean}
/** Research-only outcome reducer; callers provide validated active-clock boundaries. */
export class ResearchLifecycle {
  private sequence=0;
  private readonly states=new Map<string,State>();
  constructor(private readonly nextSequence:()=>number=()=>++this.sequence){}
  private state(identity:Identity):State {
    const key=identityKey(identity);let state=this.states.get(key);
    if(!state){state={last:0,reliable:true,invalidated:false};this.states.set(key,state);}
    return state;
  }
  invalidate(identity:Identity,reason:'conflicting_terminal'|'clock_unknown'|'recording_gap'):ResearchRecord {
    const state=this.state(identity);state.reliable=false;state.invalidated=true;
    return parseResearchRecord({schemaVersion:1,kind:'invalidate',sequence:this.nextSequence(),identity,reason});
  }
  transition(identity:Identity,event:ResearchTransition):readonly ResearchRecord[] {
    const state=this.state(identity),rows:ResearchRecord[]=[];
    if(!Number.isFinite(event.atActiveSeconds)||event.atActiveSeconds<0||event.atActiveSeconds>Number.MAX_SAFE_INTEGER)
      return state.invalidated?[]:[this.invalidate(identity,'clock_unknown')];
    if(!event.trusted||event.state==='unknown'||event.atActiveSeconds<state.last){
      if(!state.invalidated)rows.push(this.invalidate(identity,'clock_unknown'));
    }
    state.last=Math.max(state.last,event.atActiveSeconds);
    if(event.outcome===undefined)return rows;
    if(state.terminal){
      if(state.terminal.outcome!==event.outcome||state.terminal.at!==event.atActiveSeconds){
        if(!state.invalidated)rows.push(this.invalidate(identity,'conflicting_terminal'));
      }
      return rows;
    }
    const outcome=event.outcome==='normal_end'&&!state.reliable?'clock_unknown':event.outcome;
    const row=parseResearchRecord({schemaVersion:1,kind:'terminal',sequence:this.nextSequence(),identity,
      endActiveSeconds:event.atActiveSeconds,outcome,evidenceId:event.id,clockReliable:state.reliable});
    state.terminal={outcome:event.outcome,at:event.atActiveSeconds};rows.push(row);
    return rows;
  }
  forget(identity:Identity):void {this.states.delete(identityKey(identity));}
}
