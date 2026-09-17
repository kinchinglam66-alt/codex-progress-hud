import {createHash} from 'node:crypto';
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
/** Normalize acknowledged turn/start text inputs for the same exact-frame comparison. */
export function submittedSupplementItems(input:readonly unknown[]):unknown[]{
 return input.flatMap(value=>{const part=object(value);
  return part.type==='text'&&typeof part.text==='string'?[{type:'message',role:'user',content:[{type:'input_text',text:part.text}]}]:[];
 });
}
function frames(items:readonly unknown[]):string[]{
 const result:string[]=[];
 for(const item of items){
  const message=object(item);
  if(message.type!=='message'||message.role!=='user'||!Array.isArray(message.content))continue;
  for(const part of message.content){
   const p=object(part);if(p.type!=='input_text'||typeof p.text!=='string')continue;
   try{const record=object(object(JSON.parse(p.text)).observedRecord);
    if(Number.isSafeInteger(record.ordinal)&&Number.isSafeInteger(record.part)&&typeof record.final==='boolean'&&typeof record.text==='string')result.push(p.text);
   }catch{/* Ordinary native messages are not imported source frames. */}
  }
 }
 return result;
}
/** Local diagnostic evidence only, never grants inference or changes scoring. */
export function compareSupplementReadback(sentItems:readonly unknown[],rollout:readonly unknown[]){
 const sent=frames(sentItems),read=frames(rollout.filter(r=>object(r).type==='response_item').map(r=>object(r).payload));
 const digest=(value:string[])=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 return {sentFrames:sent.length,readFrames:read.length,sentDigest:digest(sent),readDigest:digest(read),
  exact:sent.length>0&&sent.length===read.length&&sent.every((value,index)=>value===read[index])};
}
