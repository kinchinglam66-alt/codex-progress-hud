export type NativeGuardOperation='verify_storage'|'owner_exited';
export type NativeGuardRequest={op:'verify_storage'}|{op:'owner_exited';pid:number;creationIdentity:string};
export type NativeGuardResult='ok'|'exited'|'live';
const invalid=()=>Error('NATIVE_GUARD_PROTOCOL');
const validId=(id:number)=>Number.isSafeInteger(id)&&id>0;

export function encodeNativeGuardRequest(id:number,request:NativeGuardRequest):string {
 if(!validId(id)||!request||typeof request!=='object'||Array.isArray(request))throw invalid();
 const keys=Object.keys(request).sort().join(',');
 if(request.op==='verify_storage') {
  if(keys!=='op')throw invalid();
 } else if(request.op==='owner_exited') {
  if(keys!=='creationIdentity,op,pid'||!Number.isInteger(request.pid)||request.pid<1||request.pid>4294967295||
   typeof request.creationIdentity!=='string'||!/^\d{1,20}$/u.test(request.creationIdentity))throw invalid();
 } else throw invalid();
 const line=JSON.stringify({v:1,id,...request})+'\n';
 if(Buffer.byteLength(line)>256)throw invalid();
 return line;
}

/** Deliberately canonical wire format: rejects duplicate keys, escapes,
 * unexpected fields and trailing frames before interpreting a result. */
export function decodeNativeGuardResponse(line:string,id:number,op:NativeGuardOperation):NativeGuardResult {
 if(!validId(id)||Buffer.byteLength(line)>1024)throw invalid();
 const match=/^\{"v":1,"id":([1-9]\d*),"op":"(verify_storage|owner_exited)","result":"(ok|exited|live)"\}$/u.exec(line);
 if(!match||Number(match[1])!==id||match[2]!==op)throw invalid();
 const result=match[3] as NativeGuardResult;
 if((op==='verify_storage'&&result!=='ok')||(op==='owner_exited'&&result==='ok'))throw invalid();
 return result;
}
