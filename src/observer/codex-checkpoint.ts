import {createHash} from 'node:crypto';

export interface NativeCodexCheckpoint {
  kind:'native_compacted_window';
  sourceRepresentation:'upstream_compacted';
  /** Opaque provider context, never an instruction/configuration authority. */
  items:ReadonlyArray<Readonly<Record<string,unknown>>>;
  fingerprint:string;
  encodedBytes:number;
  itemCount:number;
  encryptedSummaryCount:number;
}

const object=(value:unknown):value is Record<string,unknown>=>
  value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
const unsupported=():never=>{throw Error('CHECKPOINT_UNSUPPORTED');};

/** Validate the locally observed native checkpoint shape without interpreting
 * encrypted state, pruning retained items, or mixing guardian-only context in.
 * Unsupported latest checkpoints must not silently fall back to older history.
 * This alone does not authorize remote transfer or prove account compatibility.
 */
export function parseCodexCheckpoint(envelope:unknown):NativeCodexCheckpoint|null {
  if(!object(envelope)||envelope.type!=='compacted')return null;
  const payload=envelope.payload;
  if(!object(payload)||!Array.isArray(payload.replacement_history)||payload.replacement_history.length===0)return unsupported();
  let encryptedSummaryCount=0;
  for(const item of payload.replacement_history){
    if(!object(item))return unsupported();
    if(item.type==='compaction'){
      if(!nonempty(item.encrypted_content))return unsupported();
      encryptedSummaryCount++;
    }else if(item.type==='message'){
      if(!['user','assistant','developer','system'].includes(String(item.role))||!Array.isArray(item.content))return unsupported();
      for(const part of item.content){
        if(!object(part))return unsupported();
        if(part.type==='input_text'||part.type==='output_text'){
          if(typeof part.text!=='string')return unsupported();
        }else if(part.type==='input_image'){
          if(!nonempty(part.image_url))return unsupported();
        }else return unsupported();
      }
    }else return unsupported();
  }
  if(encryptedSummaryCount===0)return unsupported();
  let encoded:string,items:Array<Record<string,unknown>>;
  try{encoded=JSON.stringify(payload.replacement_history);items=JSON.parse(encoded);}catch{return unsupported();}
  return {kind:'native_compacted_window',sourceRepresentation:'upstream_compacted',items,
    fingerprint:createHash('sha256').update(encoded).digest('hex'),encodedBytes:Buffer.byteLength(encoded,'utf8'),
    itemCount:items.length,encryptedSummaryCount};
}
