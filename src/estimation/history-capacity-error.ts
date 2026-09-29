export type HistoryCapacityKind='checkpoint_window'|'attachment_manifest'|'source_budget_exhausted';
export interface HistoryCapacityDetail {kind:HistoryCapacityKind;observedBytes:number;limitBytes:number}
// Only errors created locally may contribute details; never inspect arbitrary
// exception properties or serialize a message containing source text/paths.
const details=new WeakMap<object,Readonly<HistoryCapacityDetail>>();
export function historyCapacityError(kind:HistoryCapacityKind,observedBytes:number,limitBytes:number):Error {
 const error=Error(`context_too_large:${kind}`);
 if(['checkpoint_window','attachment_manifest','source_budget_exhausted'].includes(kind)&&
   Number.isSafeInteger(observedBytes)&&Number.isSafeInteger(limitBytes)&&limitBytes>0&&observedBytes>limitBytes)
   details.set(error,Object.freeze({kind,observedBytes,limitBytes}));
 return error;
}
export function historyCapacityDetail(error:unknown):Readonly<HistoryCapacityDetail>|undefined {
 return typeof error==='object'&&error!==null?details.get(error):undefined;
}
