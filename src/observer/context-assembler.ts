import type {ConversationRecord} from './conversation-record.js';
import {extractPassiveContent} from '../hooks/passive-content.js';
import type {ObserverInput} from '../estimation/observer-contract.js';

type Estimate={remainingSeconds:number;errorPercent:number;observedActiveSeconds:number};
export interface AssemblyOptions {
  summary:string|null;summaryThroughSequence:number;sequence:number;
  activeSeconds:number;activeTimeKnown:boolean;historyComplete:boolean;nowMs:number;
  previousEstimate:Estimate|null;runtime?:ObserverInput['runtime'];
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
  const clean=(text:string,category:ObservationMetadata['omittedCategories'][number])=>{
    // Recognized host wrappers are not task prose. Conservative omission also
    // applies to quoted wrappers; flag the loss rather than claiming full context.
    const selected=text.replace(/<(environment_context|in-app-browser-context|codex_internal_context|app-context|permissions|skills_instructions)\b[^>]*>[\s\S]*?(?:<\/\1(?:\s+instructions)?\s*>|$)/giu,'');
    if(selected!==text){truncated=true;omitted.add(category);}
    const content=extractPassiveContent('Stop',{last_assistant_message:selected});
    if(!content || content.truncated){truncated=true;omitted.add(category);}
    return content?.text??'';
  };
  const messages:ObserverInput['messages']=[];
  const actions=new Map<string,{text:string;atMs:number}>();
  let actionTurn:string|null=null;
  for(const record of records){
    if(record.turnId!==null&&record.turnId!==actionTurn){actions.clear();actionTurn=record.turnId;}
    if(record.kind==='runtime'&&record.runtime!=='running')actions.clear();
    if(record.kind==='tool_result'&&record.actionId)actions.delete(record.actionId);
    if(!record.text||record.kind==='runtime')continue;
    const kind=record.kind==='user'?'user':record.kind==='assistant'?'assistant':'tool';
    const text=clean(record.text,kind);
    if(text)messages.push({kind,text,truncated:text.length!==record.text.length});
    if(record.kind==='tool_start'&&record.actionId&&text)actions.set(record.actionId,{text,atMs:record.atMs});
  }
  if(!messages.length)throw Error('CONTEXT_MISSING');
  const original=messages.find(m=>m.kind==='user');
  const latest=[...messages].reverse().find(m=>m.kind==='user');
  const action=[...actions.values()].at(-1);
  if(action && action.text.length>1024){
    action.text=Array.from(action.text).slice(0,1024).join('');
    truncated=true;omitted.add('tool');
  }
  let summary=options.summary===null?null:clean(options.summary,'summary');
  if(summary&&summary.length>2048){summary=summary.slice(0,2048).replace(/[\uD800-\uDBFF]$/u,'');truncated=true;omitted.add('summary');}
  const result:AssembledContext={goalSummary:summary||null,activeSeconds:options.activeSeconds,
    runtime:options.runtime??'running',messages,truncated,observation:{sequence:options.sequence,
      summaryThroughSequence:options.summaryThroughSequence,activeTimeKnown:options.activeTimeKnown,
      historyComplete:options.historyComplete,currentAction:action?{text:action.text,
        elapsedSeconds:Math.max(0,(options.nowMs-action.atMs)/1000)}:null,
      previousEstimate:options.previousEstimate?{...options.previousEstimate}:null,omittedCategories:[]}};
  const encode=()=>{result.observation.omittedCategories=[...omitted];return JSON.stringify(result);};
  // Preserve the initial objective and latest amendment. Drop low-priority tool logs
  // before other messages; only trim protected messages when they alone exceed budget.
  while(messages.length>128||Buffer.byteLength(encode(),'utf8')>16384){
    result.truncated=true;
    let index=messages.findIndex(m=>m.kind==='tool');
    if(index<0)index=messages.findIndex(m=>m!==original&&m!==latest);
    if(index>=0&&messages.length>1){omitted.add(messages[index]!.kind);messages.splice(index,1);continue;}
    const candidate=[...messages].sort((a,b)=>b.text.length-a.text.length).find(m=>m.text.length>32);
    if(!candidate)throw Error('CONTEXT_LIMIT');
    const chars=Array.from(candidate.text),size=Math.max(1,Math.floor(chars.length/3));
    candidate.text=chars.slice(0,size).join('')+'\n[…]\n'+chars.slice(-size).join('');
    candidate.truncated=true;omitted.add(candidate.kind);
  }
  encode();
  return result;
}
