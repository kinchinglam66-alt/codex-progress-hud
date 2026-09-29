/** Monotonic, per-turn product clock. Tracking controls do not pause the source
 * task. Only adapter-attested full human blockage can stop this clock. */
export class EtaLiveClock {
  private excluded:Array<{start:number;end:number}>=[];
  private blockedAt:number|null=null;
  private endedAt:number|null=null;
  private lastAt:number;
  unknownBlocking=false;
  uncertain=false;
  constructor(private startAt:number,private baselineSeconds=0){
    if(!Number.isFinite(startAt)||!Number.isFinite(baselineSeconds)||baselineSeconds<0)throw Error('invalid_eta_clock');
    this.lastAt=startAt;
  }
  elapsed(now:number):number {
    if(!Number.isFinite(now)||now<this.startAt)throw Error('invalid_eta_clock');
    const end=this.endedAt??now;
    const excludedMs=this.excluded.reduce((sum,s)=>sum+Math.max(0,Math.min(end,s.end)-s.start),0);
    return this.baselineSeconds+Math.max(0,end-this.startAt-excludedMs-
      (this.blockedAt===null?0:Math.max(0,end-this.blockedAt)))/1000;
  }
  blocking(kind:'none'|'unknown'|'confirmed_human',at:number):void {
    if(!Number.isFinite(at)||at<this.lastAt)throw Error('eta_clock_reversed');
    if(this.endedAt!==null)return;
    this.lastAt=at;
    if(this.blockedAt!==null&&kind!=='confirmed_human'){
      this.excluded.push({start:this.blockedAt,end:at});this.blockedAt=null;
    }
    if(kind==='confirmed_human'&&this.blockedAt===null)this.blockedAt=at;
    this.unknownBlocking=kind==='unknown';
    if(this.unknownBlocking)this.uncertain=true;
  }
  end(at:number):void {
    if(!Number.isFinite(at)||at<this.startAt)throw Error('eta_terminal_clock_reversed');
    if(this.endedAt===null){this.endedAt=at;this.unknownBlocking=false;}
  }
  get humanBlocked(){return this.blockedAt!==null&&this.endedAt===null;}
  /** A verified native start can precede late attachment. Never move it forward. */
  earlierStart(at:number):boolean {
    // A native turn may predate this process's monotonic origin.
    if(!Number.isFinite(at)||at>=this.startAt||this.baselineSeconds!==0)return false;
    this.startAt=at;return true;
  }
  get startedAt(){return this.startAt;}
}
