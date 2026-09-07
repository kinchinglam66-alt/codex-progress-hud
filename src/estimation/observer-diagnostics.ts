import {spawn} from 'node:child_process';
import {createOwnedProcessRunner,type Invocation,type OwnedProcessResult} from './owned-process.js';
import {createObserverOutputParser} from './codex-output.js';

export interface ObserverDiagnostic {
 reason:OwnedProcessResult['reason'];exitCode:number|null;closed:boolean;
 parserError:ReturnType<ReturnType<typeof createObserverOutputParser>['end']>['error'];
 elapsedMs:number;errorCategories:string[];
}
/** Opt-in local diagnostic runner. Categories are hints, never raw error text.
 * Keeps existing parser cancellation, child ownership and 60-second limit. */
export function createObserverDiagnosticRunner(sink:(value:ObserverDiagnostic)=>void) {
 let stderr='';
 const runner=createOwnedProcessRunner({spawn:(executable,args,options)=>{
  const child=spawn(executable,args,options);
  child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=(chunk.toString()).slice(0,65536-stderr.length);});
  return child;
 }});
 return {...runner,async run(invocation:Invocation,signal:AbortSignal) {
  if(runner.status().active || runner.status().disabled)return runner.run(invocation,signal);
  stderr='';const start=Date.now();const parser=createObserverOutputParser();
  let pending='';const decoder=new TextDecoder();
  const result=await runner.run({...invocation,onStdout:chunk=>{
   pending+=decoder.decode(chunk,{stream:true});let end;
   while((end=pending.indexOf('\n'))>=0){
    const line=pending.slice(0,end);pending=pending.slice(end+1);
    if(line.length<=16384)try{
     const event=JSON.parse(line);
     const message=event.type==='error'?event.message:event.type==='turn.failed'?event.error?.message:null;
     if(typeof message==='string' && stderr.length<65536)stderr+='\n'+message.slice(0,65535-stderr.length);
    }catch{/* Parser owns structural rejection. */}
   }
   if(pending.length>16384)pending='';
   const observed=parser.push(chunk);
   return invocation.onStdout ? invocation.onStdout(chunk) : observed;
  }},signal);
  const output=parser.end();
  const patterns:[string,RegExp][]=[
   ['http_401',/\b(?:HTTP|status(?: code)?)[:\s]+401\b/i],
   ['http_403',/\b(?:HTTP|status(?: code)?)[:\s]+403\b/i],
   ['http_429',/\b(?:HTTP|status(?: code)?)[:\s]+429\b/i],
   ['tls',/certificate|TLS|SSL|Schannel/i],['connection',/error sending request|ECONNREFUSED|connection reset|connect error/i],
   ['unsupported_model',/model.{0,80}(?:not supported|not found|does not exist)/i],
   ['invalid_argument',/unexpected argument|unrecognized option|unknown option/i],
  ];
  const errorCategories=patterns.filter(([,pattern])=>pattern.test(stderr)).map(([code])=>code);
  stderr='';pending='';
  try{sink({reason:result.reason,exitCode:result.exitCode,closed:result.closed,parserError:output.error,elapsedMs:Date.now()-start,errorCategories});}catch{/* Diagnostics cannot affect execution. */}
  return result;
 }};
}
