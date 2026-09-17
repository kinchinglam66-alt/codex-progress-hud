import {observerResponseSchema} from '../estimation/observer-contract.js';
export type TrialEventAction='continue'|'unexpected_turn'|'unexpected_compaction'|'unexpected_item';
/** Pinned protocol display items are not executable tool items. Unknown kinds
 * remain fail-closed; a compaction is permitted only under its own admission. */
export function classifyNativeTrialEvent(method:string,itemType:unknown,purpose:'eta'|'context_compression'|undefined):TrialEventAction{
 if(method==='turn/started'&&purpose===undefined)return 'unexpected_turn';
 if(method!=='item/started')return 'continue';
 if(itemType==='contextCompaction')return purpose==='context_compression'?'continue':'unexpected_compaction';
 if(typeof itemType==='string'&&['userMessage','agentMessage','reasoning','plan'].includes(itemType))return 'continue';
 return 'unexpected_item';
}
/** Diagnostic only: never returns response content, values or validator messages. */
export function describeNativeTrialOutput(text:unknown):{category:string;bytes:number|null;issues:Array<{field:string;code:string}>;shape?:{relation:string;status:string;summaryPresent:boolean;estimatePresent:boolean;workPresent:boolean}}{
 if(typeof text!=='string')return {category:'missing',bytes:null,issues:[]};
 const bytes=Buffer.byteLength(text);
 if(bytes===0)return {category:'empty',bytes,issues:[]};
 if(bytes>262144)return {category:'oversize',bytes,issues:[]};
 let value:unknown;
 try{value=JSON.parse(text);}catch{return {category:'invalid_json',bytes,issues:[]};}
 const checked=observerResponseSchema.safeParse(value);
 if(checked.success)return {category:'valid',bytes,issues:[]};
 const fields=['relation','status','summary','basis','estimate','work'];
 const codes=['invalid_type','too_big','too_small','invalid_format','invalid_value','custom','unrecognized_keys','invalid_union'];
 const row=value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
 const relation=typeof row.relation==='string'&&['continue','replace','unknown'].includes(row.relation)?row.relation:'invalid';
 const status=typeof row.status==='string'&&['running','waiting','completed','unknown'].includes(row.status)?row.status:'invalid';
 return {category:'invalid_schema',bytes,shape:{relation,status,summaryPresent:row.summary!=null,estimatePresent:row.estimate!=null,workPresent:row.work!=null},issues:checked.error.issues.slice(0,12).map(issue=>({
  field:typeof issue.path[0]==='string'&&fields.includes(issue.path[0])?issue.path[0]:'other',
  code:codes.includes(issue.code)?issue.code:'other',
 }))};
}
