import { performance } from "node:perf_hooks";
import { createControlledOutputParser, type CallKind, type CallUsage, type ControlledOutput } from "./controlled-output.js";
import type { Invocation, OwnedProcessResult } from "../estimation/owned-process.js";

interface Options {
  task:string;kind:CallKind;invocation:Invocation;signal:AbortSignal;
  ledger:{reserve(task:string,lane:CallKind):Promise<number|null>;settle(id:number,usage:CallUsage|null):Promise<void>};
  runner:{run(invocation:Invocation,signal:AbortSignal):Promise<OwnedProcessResult>};
  onUnsafe?:()=>void;
}
export interface ControlledCallResult {
  reservationId:number|null;
  status:ControlledOutput["status"]|"not_admitted"|"process_error";
  answer:ControlledOutput["answer"];usage:CallUsage|null;
  requestedAt:string|null;deliveredAt:string|null;durationMs:number|null;
  closed:boolean;processReason:string|null;
  failureCategory?:string|null;
  protocolEvents?:string[];
}
/** Shared controller decision; a rejected optional observer is not unknown usage. */
export function collectionMustStop(kind:CallKind,result:ControlledCallResult,
  accounting:{unreconciledUnknown:number;overrun:boolean}):boolean {
  if(!result.closed || accounting.unreconciledUnknown>0 || accounting.overrun)return true;
  if(kind==='estimator' && result.status==='not_admitted' && result.reservationId===null &&
    result.requestedAt===null && result.deliveredAt===null && result.durationMs===null &&
    result.processReason===null && result.usage===null && result.answer===null)return false;
  return result.status==='not_admitted' || result.usage===null;
}
/** One accounted request. The caller owns runner cancellation and must stop all
 * dispatch on unknown usage, ledger failure, or unconfirmed process closure.
 * Times include child startup, inference and shutdown, not admission fsync.
 */
export async function runControlledCall(options:Options):Promise<ControlledCallResult> {
  try { return await runAccounted(options); }
  catch(error) { options.onUnsafe?.(); throw error; }
}
async function runAccounted(options:Options):Promise<ControlledCallResult> {
  const {ledger,runner,task,kind,invocation,signal}=options;
  const id=await ledger.reserve(task,kind);
  if(id===null)return {reservationId:null,status:"not_admitted",answer:null,usage:null,
    requestedAt:null,deliveredAt:null,durationMs:null,closed:true,processReason:null};
  const parser=createControlledOutputParser(kind),requestedAt=new Date().toISOString(),start=performance.now();
  let processResult:OwnedProcessResult|undefined;
  try { processResult=await runner.run({...invocation,onStdout:chunk=>parser.push(chunk)},signal); }
  catch { /* Dispatch may already have occurred. Unknown is not zero usage. */ }
  const deliveredAt=new Date().toISOString(),durationMs=performance.now()-start;
  const output=parser.end();
  const closed=processResult?.closed===true;
  const usage=closed?output.usage:null;
  if(usage===null)options.onUnsafe?.();
  // Persist accounting before handing an answer to the experiment consumer.
  await ledger.settle(id,usage);
  const successful=closed && processResult?.reason==="exited" && processResult.exitCode===0;
  return {reservationId:id,status:successful?output.status:"process_error",
    answer:successful?output.answer:null,usage,requestedAt,deliveredAt,durationMs,closed,
    processReason:processResult?.reason??"runner_exception",failureCategory:parser.diagnostic(),protocolEvents:parser.protocolEvents()};
}
