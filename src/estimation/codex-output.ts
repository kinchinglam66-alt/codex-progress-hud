import { z } from "zod";
import { predictionSchema, type Prediction } from "./contracts.js";
import { observerResponseSchema, type ObserverResponse } from './observer-contract.js';
import {COMPRESSION_OUTPUT_TEXT_LIMIT} from './context-compression.js';
const tokens=z.number().int().nonnegative().max(1_000_000_000);
const usageSchema=z.object({input_tokens:tokens,output_tokens:tokens,cached_input_tokens:tokens.optional(),cache_write_input_tokens:tokens.optional(),reasoning_output_tokens:tokens.optional()}).strict()
  .refine(x=>x.cached_input_tokens===undefined || x.cached_input_tokens<=x.input_tokens);
const unavailable=z.object({lowSeconds:z.null(),highSeconds:z.null()}).strict();
const id=z.string().min(1).max(256);
const itemSchema=z.discriminatedUnion("type",[
  z.object({id,type:z.literal("agent_message"),text:z.string()}).strict(),
  z.object({id,type:z.literal("reasoning"),text:z.string()}).strict(),
  z.object({id,type:z.literal("error"),message:z.string()}).strict()
]);
const eventSchema=z.discriminatedUnion("type",[
  z.object({type:z.literal("thread.started"),thread_id:id}).strict(),
  z.object({type:z.literal("turn.started")}).strict(),
  z.object({type:z.literal("turn.completed"),usage:z.unknown()}).strict(),
  z.object({type:z.literal("error"),message:z.string()}).strict(),
  z.object({type:z.literal("item.started"),item:itemSchema}).strict(),
  z.object({type:z.literal("item.updated"),item:itemSchema}).strict(),
  z.object({type:z.literal("item.completed"),item:itemSchema}).strict()
]);
type ErrorCode="protocol"|"encoding"|"output_limit"|"unexpected_tool"|"invalid_prediction"|"missing_usage";
export interface SubscriptionUsage { kind:"subscription-tokens"; inputTokens:number; outputTokens:number; cachedInputTokens:number|null }
export interface CodexOutput<T = Prediction> { ok:boolean; prediction:T|null; usage:SubscriptionUsage|null; error:ErrorCode|null }
export type ObserverPredictionStatus = "numeric"|"unknown"|"invalid";
export type ObserverUsageStatus = "known"|"unknown";
export interface ObserverOutput {
  ok:boolean;
  interpretation:ObserverResponse|null;
  usage:SubscriptionUsage|null;
  error:ErrorCode|null;
  framingValid:boolean;
  predictionStatus:ObserverPredictionStatus;
  usageStatus:ObserverUsageStatus;
}

export interface CompressionOutput {
  summary: {text: string; firstOrdinal: number; lastOrdinal: number}|null;
  usage: SubscriptionUsage|null;
  error: ErrorCode|null;
  framingValid: boolean;
  summaryStatus: 'valid'|'invalid';
}


/** No raw CLI event/reasoning/identity escapes this parser. Typed observer summaries
 * are private task content and must not be logged. feed false means caller must
 * cancel the owned process; an ended or failed parser cannot accept more data.
 */
function createOutputParser<T>(decodeAnswer: (value: unknown) => T|null) {
  const decoder=new TextDecoder("utf-8",{fatal:true});
  let pending="", bytes=0, threadStarted=false, started=false, completed=false, answered=false, ended=false;
  let error:ErrorCode|null=null, prediction:T|null=null, usage:SubscriptionUsage|null=null;
  const fail=(code:ErrorCode)=>{ error ??= code; pending=""; return false; };
  function line(text:string):boolean {
    if(text.length>16_384) return fail("output_limit");
    if(!text.trim()) return true;
    let event:Record<string,unknown>;
    try { const value:unknown=JSON.parse(text); event=z.record(z.string(),z.unknown()).parse(value); }
    catch { return fail("protocol"); }
    if(completed) return fail("protocol");
    // Detect forbidden item kinds before strict structural validation, so the
    // owner can distinguish unexpected tool activity from a malformed frame.
    if(["item.started","item.updated","item.completed"].includes(String(event.type))) {
      const kind=z.object({type:z.string()}).safeParse(event.item);
      if(kind.success && !["agent_message","reasoning","error"].includes(kind.data.type)) return fail("unexpected_tool");
    }
    if(!eventSchema.safeParse(event).success) return fail("protocol");
    if(event.type==="thread.started") {
      if(started || threadStarted) return fail("protocol");
      threadStarted=true; return true;
    }
    if(event.type==="turn.started") { if(started) return fail("protocol"); started=true; return true; }
    if(event.type==="error") return true; // CLI may recover transport errors; never expose text.
    if(event.type==="turn.failed") return fail("protocol");
    if(event.type==="turn.completed") {
      if(!started || !answered) return fail("protocol");
      const parsed=usageSchema.safeParse(event.usage); if(!parsed.success) return fail("missing_usage");
      usage={kind:"subscription-tokens",inputTokens:parsed.data.input_tokens,outputTokens:parsed.data.output_tokens,cachedInputTokens:parsed.data.cached_input_tokens??null};
      completed=true; return true;
    }
    if(!["item.started","item.updated","item.completed"].includes(String(event.type))) return fail("protocol");
    const parsedItem=itemSchema.safeParse(event.item);
    if(!parsedItem.success) return fail("protocol");
    const item=parsedItem.data;
    if(!["agent_message","reasoning","error"].includes(item.type)) return fail("unexpected_tool");
    if(item.type==="error") return true;
    if(!started) return fail("protocol");
    if(item.type==="agent_message" && event.type==="item.completed") {
      if(answered) return fail("protocol");
      let value:unknown; try { value=JSON.parse(item.text); } catch { return fail("invalid_prediction"); }
      try { prediction=decodeAnswer(value); }
      catch { return fail("invalid_prediction"); }
      answered=true;
    }
    return true;
  }
  function consume(text:string):boolean {
    pending+=text;
    let index;
    while((index=pending.indexOf("\n"))>=0) {
      const part=pending.slice(0,index); pending=pending.slice(index+1);
      if(!line(part)) return false;
    }
    return pending.length<=16_384 || fail("output_limit");
  }
  return {
    push(chunk:Uint8Array):boolean {
      if(ended || error) return false;
      bytes+=chunk.byteLength; if(bytes>262_144) return fail("output_limit");
      try { return consume(decoder.decode(chunk,{stream:true})); } catch { return fail("encoding"); }
    },
    end():CodexOutput<T> {
      if(!ended) {
        if(!error) {
          try { consume(decoder.decode()); } catch { fail("encoding"); }
          if(!error && pending) { const last=pending; pending=""; line(last); }
        }
        ended=true;
        if(!error && (!started || !completed || !answered)) fail("protocol");
      }
      return {ok:error===null,prediction:error?null:prediction,usage:error?null:(usage?{...usage}:null),error};
    }
  };
}

export function createCodexOutputParser() {
  return createOutputParser<Prediction>(value => {
    const valid = predictionSchema.safeParse(value);
    if (valid.success) return Object.freeze(valid.data);
    unavailable.parse(value);
    return null;
  });
}

/** Rich response decoding shares the same no-tools, bounded lifecycle and usage
 * guards as the numeric pilot. This is not live dispatch or spending authority.
 */
export function createObserverOutputParser() {
  const decoder=new TextDecoder("utf-8",{fatal:true});
  let pending="", bytes=0, threadStarted=false, started=false, completed=false, answered=false, ended=false;
  let fatalError:ErrorCode|null=null, semanticError:ErrorCode|null=null;
  let interpretation:ObserverResponse|null=null, usage:SubscriptionUsage|null=null;
  const fail=(code:ErrorCode)=>{ fatalError=code; pending=""; return false; };
  const semanticFail=(code:ErrorCode)=>{ semanticError ??= code; return true; };
  function line(text:string):boolean {
    if(fatalError) return false;
    if(text.length>16_384) return fail("output_limit");
    if(!text.trim()) return true;
    let event:Record<string,unknown>;
    try { const value:unknown=JSON.parse(text); event=z.record(z.string(),z.unknown()).parse(value); }
    catch { return fail("protocol"); }
    if(completed) return fail("protocol");
    if(["item.started","item.updated","item.completed"].includes(String(event.type))) {
      const kind=z.object({type:z.string()}).safeParse(event.item);
      if(kind.success && !["agent_message","reasoning","error"].includes(kind.data.type)) return fail("unexpected_tool");
    }
    const validEvent=event.type==="turn.completed"
      ? z.object({type:z.literal("turn.completed"),usage:z.unknown().optional()}).strict().safeParse(event)
      : eventSchema.safeParse(event);
    if(!validEvent.success) return fail("protocol");
    if(event.type==="thread.started") {
      if(started || threadStarted) return fail("protocol");
      threadStarted=true; return true;
    }
    if(event.type==="turn.started") {
      if(started) return fail("protocol");
      started=true; return true;
    }
    if(event.type==="error") return true;
    if(event.type==="turn.completed") {
      if(!started || !answered) return fail("protocol");
      const parsed=usageSchema.safeParse(event.usage);
      if(parsed.success) {
        usage={kind:"subscription-tokens",inputTokens:parsed.data.input_tokens,
          outputTokens:parsed.data.output_tokens,cachedInputTokens:parsed.data.cached_input_tokens??null};
      } else semanticFail("missing_usage");
      completed=true;
      return true;
    }
    if(!["item.started","item.updated","item.completed"].includes(String(event.type))) return fail("protocol");
    const parsedItem=itemSchema.safeParse(event.item);
    if(!parsedItem.success) return fail("protocol");
    const item=parsedItem.data;
    if(item.type==="error") return true;
    if(!started) return fail("protocol");
    if(item.type==="agent_message" && event.type==="item.completed") {
      if(answered) return fail("protocol");
      answered=true;
      let value:unknown;
      try { value=JSON.parse(item.text); } catch { return semanticFail("invalid_prediction"); }
      const parsedAnswer=observerResponseSchema.safeParse(value);
      if(parsedAnswer.success) interpretation=Object.freeze(parsedAnswer.data);
      else semanticFail("invalid_prediction");
    }
    return true;
  }
  function consume(text:string):boolean {
    pending+=text;
    let index;
    while((index=pending.indexOf("\n"))>=0) {
      const part=pending.slice(0,index); pending=pending.slice(index+1);
      if(!line(part)) return false;
    }
    return pending.length<=16_384 || fail("output_limit");
  }
  return {
    push(chunk:Uint8Array):boolean {
      if(ended || fatalError) return false;
      bytes+=chunk.byteLength;
      if(bytes>262_144) return fail("output_limit");
      try { return consume(decoder.decode(chunk,{stream:true})); }
      catch { return fail("encoding"); }
    },
    end():ObserverOutput {
      if(!ended) {
        if(!fatalError) {
          try { consume(decoder.decode()); } catch { fail("encoding"); }
          if(!fatalError && pending) { const last=pending; pending=""; line(last); }
        }
        if(!fatalError && (!started || !answered || !completed)) fail("protocol");
        ended=true;
      }
      const framingValid=fatalError===null && started && answered && completed;
      const usableInterpretation=framingValid && semanticError!=="invalid_prediction" && interpretation!==null
        ? {...interpretation,estimate:interpretation.estimate===null ? null : {...interpretation.estimate}}
        : null;
      const predictionStatus:ObserverPredictionStatus=!framingValid || semanticError==="invalid_prediction" || interpretation===null
        ? "invalid" : interpretation.estimate===null ? "unknown" : "numeric";
      const error=fatalError ?? semanticError;
      return {ok:framingValid && semanticError===null && usage!==null,
        interpretation:usableInterpretation, usage:usage ? {...usage} : null, error,
        framingValid, predictionStatus, usageStatus:usage===null ? "unknown" : "known"};
    }
  };
}

/** Dedicated read-only summary protocol. It deliberately does not parse the
 * ETA response schema, and it rejects tool-shaped output before accepting an
 * answer. Usage is parsed independently so malformed answers retain billing
 * evidence. */
export function createCompressionOutputParser() {
  const decoder=new TextDecoder("utf-8",{fatal:true});
  const summarySchema=z.object({
    text:z.string().trim().min(1).max(COMPRESSION_OUTPUT_TEXT_LIMIT),
    firstOrdinal:z.number().int().nonnegative().safe(),
    lastOrdinal:z.number().int().nonnegative().safe(),
  }).strict().refine(value=>value.lastOrdinal>=value.firstOrdinal);
  let pending="", bytes=0, threadStarted=false, started=false, completed=false, answered=false, ended=false;
  let fatalError:ErrorCode|null=null, semanticError:ErrorCode|null=null;
  let summary:CompressionOutput['summary']=null, usage:SubscriptionUsage|null=null;
  const fail=(code:ErrorCode)=>{fatalError=code;pending="";return false;};
  function line(text:string):boolean {
    if(fatalError)return false;
    if(text.length>16_384)return fail("output_limit");
    if(!text.trim())return true;
    let event:Record<string,unknown>;
    try{const value:unknown=JSON.parse(text);event=z.record(z.string(),z.unknown()).parse(value);}catch{return fail("protocol");}
    if(completed)return fail("protocol");
    if(["item.started","item.updated","item.completed"].includes(String(event.type))){
      const kind=z.object({type:z.string()}).safeParse(event.item);
      if(kind.success&&!['agent_message','reasoning','error'].includes(kind.data.type))return fail('unexpected_tool');
    }
    const validEvent=event.type==="turn.completed"
      ? z.object({type:z.literal("turn.completed"),usage:z.unknown().optional()}).strict().safeParse(event)
      : eventSchema.safeParse(event);
    if(!validEvent.success)return fail("protocol");
    if(event.type==="thread.started"){if(started||threadStarted)return fail("protocol");threadStarted=true;return true;}
    if(event.type==="turn.started"){if(started)return fail("protocol");started=true;return true;}
    if(event.type==="error")return true;
    if(event.type==="turn.completed"){
      if(!started||!answered)return fail("protocol");
      const parsed=usageSchema.safeParse(event.usage);
      if(parsed.success)usage={kind:"subscription-tokens",inputTokens:parsed.data.input_tokens,outputTokens:parsed.data.output_tokens,cachedInputTokens:parsed.data.cached_input_tokens??null};
      else semanticError??="missing_usage";
      completed=true;return true;
    }
    if(!["item.started","item.updated","item.completed"].includes(String(event.type)))return fail("protocol");
    const parsedItem=itemSchema.safeParse(event.item);if(!parsedItem.success)return fail("protocol");
    const item=parsedItem.data;if(item.type==="error")return true;if(!started)return fail("protocol");
    if(item.type==="agent_message"&&event.type==="item.completed"){
      if(answered)return fail("protocol");answered=true;
      let value:unknown;try{value=JSON.parse(item.text);}catch{semanticError??="invalid_prediction";return true;}
      const parsed=summarySchema.safeParse(value);if(parsed.success)summary=Object.freeze({...parsed.data});else semanticError??="invalid_prediction";
    }
    return true;
  }
  function consume(text:string):boolean{
    pending+=text;let index;
    while((index=pending.indexOf("\n"))>=0){const part=pending.slice(0,index);pending=pending.slice(index+1);if(!line(part))return false;}
    return pending.length<=16_384||fail("output_limit");
  }
  return {
    push(chunk:Uint8Array):boolean{
      if(ended||fatalError)return false;bytes+=chunk.byteLength;if(bytes>262_144)return fail("output_limit");
      try{return consume(decoder.decode(chunk,{stream:true}));}catch{return fail("encoding");}
    },
    end():CompressionOutput{
      if(!ended){
        if(!fatalError){try{consume(decoder.decode());}catch{fail("encoding");}if(!fatalError&&pending){const last=pending;pending="";line(last);}}
        if(!fatalError&&(!started||!answered||!completed))fail("protocol");ended=true;
      }
      const framingValid=fatalError===null&&started&&answered&&completed;
      const validSummary=framingValid&&semanticError!=="invalid_prediction"&&summary!==null?{...summary}:null;
      return {summary:validSummary,usage:usage?{...usage}:null,error:fatalError??semanticError,framingValid,summaryStatus:validSummary?"valid":"invalid"};
    }
  };
}

/** JSONL parser for the read-only context summarizer. It intentionally does
 * not share the ETA answer schema: a summary has only text and ordinal
 * coverage, and tool-shaped output is never granted execution authority. */
