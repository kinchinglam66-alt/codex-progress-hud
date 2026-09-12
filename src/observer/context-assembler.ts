import type {ConversationRecord} from './conversation-record.js';
import type {ObserverInput} from '../estimation/observer-contract.js';
import {retainObserverInput} from '../estimation/observer-retention.js';

type Estimate={remainingSeconds:number;errorPercent:number;observedActiveSeconds:number};
export interface AssemblyOptions {
  summary:string|null;summaryThroughSequence:number;sequence:number;
  activeSeconds:number;activeTimeKnown:boolean;historyComplete:boolean;nowMs:number;
  previousEstimate:Estimate|null;runtime?:ObserverInput['runtime'];currentTurnId?:string|null;
}
export interface ObservationMetadata {
  sequence:number;summaryThroughSequence:number;activeTimeKnown:boolean;historyComplete:boolean;
  currentAction:{text:string;elapsedSeconds:number}|null;
  previousEstimate:Estimate|null;omittedCategories:Array<'user'|'assistant'|'tool'|'summary'>;
}
export type AssembledContext=ObserverInput & {observation:ObservationMetadata};

/** Single semantic selection boundary. Never logs raw source records or invokes tools. */
export function assembleContext(records:readonly ConversationRecord[],options:AssemblyOptions):AssembledContext {
  if(![options.nowMs,options.activeSeconds,options.sequence,options.summaryThroughSequence]
    .every(n=>Number.isFinite(n)&&n>=0)||options.summaryThroughSequence>options.sequence)throw Error('INVALID_CONTEXT_CLOCK');
  const omitted=new Set<ObservationMetadata['omittedCategories'][number]>();
  let truncated=false;
  const messages:ObserverInput['messages']=[];
  const loss={suppliedMessages:0,retainedMessages:0,droppedByKind:{user:0,assistant:0,tool:0},clippedMessages:0};
  const pairs=new Map<string,number[]>();
  let nextPair=0;
  const actions=new Map<string,{text:string;atMs:number}>();
  let actionTurn:string|null=null;
  for(const [ordinal,record] of records.entries()){
    if(record.turnId!==null&&record.turnId!==actionTurn){actions.clear();actionTurn=record.turnId;}
    if(record.kind==='runtime'&&record.runtime!=='running')actions.clear();
    if(record.kind==='tool_result'&&record.actionId)actions.delete(record.actionId);
    if(!record.text||record.kind==='runtime')continue;
    const kind=record.kind==='user'?'user':record.kind==='assistant'?'assistant':'tool';
    loss.suppliedMessages++;
    const text=record.text;
    let pairOrdinal:number|undefined;
    if(kind==='tool'&&record.actionId&&record.turnId!==null){
      const key=JSON.stringify([record.turnId,record.actionId]);
      const pending=pairs.get(key)??[];
      if(record.kind==='tool_start'){
        pairOrdinal=nextPair++;pending.push(pairOrdinal);pairs.set(key,pending);
      }else{
        // Reused IDs match only one unambiguous outstanding start. Overlapping
        // starts are not enough evidence to choose a counterpart.
        pairOrdinal=pending.length===1?pending[0]!:nextPair++;
        pairs.delete(key);
      }
    }
    if(!Number.isFinite(record.atMs)||record.atMs<0||record.atMs>Number.MAX_SAFE_INTEGER)throw Error('INVALID_CONTEXT_CLOCK');
    if(text)messages.push({kind,text,truncated:false,
      ...(options.currentTurnId===undefined||record.turnId===options.currentTurnId?{scope:'current' as const}:{scope:'background' as const}),event:{
      ordinal,kind:record.kind,atMs:record.atMs,...(pairOrdinal===undefined?{}:{pairOrdinal})}});
    else loss.droppedByKind[kind]++;
    if(record.kind==='tool_start'&&record.actionId&&text)actions.set(record.actionId,{text,atMs:record.atMs});
  }
  if(!messages.length)throw Error('CONTEXT_MISSING');
  const action=[...actions.values()].at(-1);
  let summary=options.summary;
  if(summary&&summary.length>2048){summary=summary.slice(0,2048).replace(/[\uD800-\uDBFF]$/u,'');truncated=true;omitted.add('summary');}
  const result:AssembledContext={goalSummary:summary||null,activeSeconds:options.activeSeconds,
    runtime:options.runtime??'running',messages,truncated,packingLoss:loss,observation:{sequence:options.sequence,
      summaryThroughSequence:options.summaryThroughSequence,activeTimeKnown:options.activeTimeKnown,
      historyComplete:options.historyComplete,currentAction:action?{text:action.text,
        elapsedSeconds:Math.max(0,(options.nowMs-action.atMs)/1000)}:null,
      previousEstimate:options.previousEstimate?{...options.previousEstimate}:null,omittedCategories:[]}};
  result.observation.omittedCategories=[...omitted];
  retainObserverInput(result);
  return result;
}
