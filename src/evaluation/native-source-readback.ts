import {createHash} from 'node:crypto';
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function firstUserContents(rollout:readonly unknown[]):string[]{
 return rollout.flatMap(row=>{
  const envelope=object(row),message=object(envelope.payload);
  return envelope.type==='response_item'&&message.type==='message'&&message.role==='user'&&Array.isArray(message.content)
   ?[JSON.stringify(message.content)]:[];
 });
}
function hasReconstruction(rollout:readonly unknown[]):boolean{
 return rollout.some(row=>{
  const envelope=object(row),payload=object(envelope.payload);
  return envelope.type==='compacted'||envelope.type==='event_msg'&&payload.type==='thread_rolled_back';
 });
}
/** Persistence evidence only: never asserts what a remote model received or changes scoring. */
export function compareFirstSourceUserReadback(source:readonly unknown[],ownedRollout:readonly unknown[]){
 const original=firstUserContents(source)[0];
 const sourceDigest=original===undefined?null:digest(original);
 if(original===undefined)return {status:'source_user_missing' as const,sourceDigest,firstUserExact:null};
 // Raw older entries are not necessarily effective history after replacement or rollback.
 if(hasReconstruction(source)||hasReconstruction(ownedRollout))return {status:'reconstruction_unverified' as const,sourceDigest,firstUserExact:null};
 const users=firstUserContents(ownedRollout);
 return {status:'observed' as const,sourceDigest,firstUserDigest:users[0]===undefined?null:digest(users[0]),
  firstUserExact:users[0]===original,sourceUserOccurrences:users.filter(value=>value===original).length,userMessageCount:users.length};
}
/** Callers provide only custody-checked local reads; no RPC or inference belongs here. */
export async function collectSourceReadback(source:readonly unknown[],targets:readonly {role:'base'|'child';read:()=>Promise<readonly unknown[]>}[]){
 const results=[];
 for(const target of targets){
  try{results.push({role:target.role,...compareFirstSourceUserReadback(source,await target.read())});}
  catch{results.push({role:target.role,status:'read_unavailable' as const});}
 }
 return results;
}
