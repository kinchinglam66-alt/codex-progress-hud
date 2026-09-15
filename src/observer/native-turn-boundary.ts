export interface NativeTurnBoundary {
  currentTurnId:string;
  currentStartOffset:number;
  watermark:number;
  completed:{turnId:string;endOffset:number}|null;
}

export interface NativeTurnIndex {
  observe(envelope:unknown,startOffset:number,endOffset:number):void;
  snapshot():NativeTurnBoundary|null;
}

const object=(value:unknown):Record<string,unknown>|null=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const terminals=new Set(['task_complete','task_failed','turn_aborted']);
const lifecycle=new Set(['task_started',...terminals,'turn_started','turn_completed','turn_failed','turn_interrupted']);

/** Structural index only. The owner supplies validated, contiguous JSONL
 * envelopes and recreates the index after source identity/checkpoint resets.
 * No history text, source paths or executable source instructions are retained. */
export function createNativeTurnIndex():NativeTurnIndex {
  let invalid=false,watermark=0;
  let current:{turnId:string;startOffset:number}|null=null;
  let completed:NativeTurnBoundary['completed']=null;
  return {
    observe(envelope,startOffset,endOffset){
      if(invalid)return;
      if(!Number.isSafeInteger(startOffset)||!Number.isSafeInteger(endOffset)||
        startOffset!==watermark||endOffset<=startOffset){invalid=true;return;}
      watermark=endOffset;
      const row=object(envelope),payload=object(row?.payload);
      if(!row||typeof row.type!=='string'){invalid=true;return;}
      // Do not inspect quoted text, function arguments or arbitrary user data.
      const identities=[row,payload].flatMap(part=>part===null?[]:
        ['turn_id','turnId'].filter(key=>Object.hasOwn(part,key)).map(key=>part[key]));
      if(identities.some(id=>typeof id!=='string'||id.trim().length===0)||
        new Set(identities).size>1){invalid=true;return;}
      const turnId=identities[0] as string|undefined;
      const type=payload?.type;
      if(lifecycle.has(row.type)||(row.type==='event_msg'&&typeof type==='string'&&lifecycle.has(type))){
        if(row.type!=='event_msg'||typeof type!=='string'||!turnId){invalid=true;return;}
        if(type==='task_started'){
          if(current&&current.turnId!==turnId){invalid=true;return;}
          current??={turnId,startOffset};
        }else if(terminals.has(type)){
          if(!current||current.turnId!==turnId){invalid=true;return;}
          completed={turnId,endOffset};current=null;
        }else invalid=true;
      }else if(turnId!==undefined&&turnId!==current?.turnId){invalid=true;}
    },
    snapshot(){
      if(invalid||!current)return null;
      return {currentTurnId:current.turnId,currentStartOffset:current.startOffset,watermark,
        completed:completed===null?null:{...completed}};
    }
  };
}
