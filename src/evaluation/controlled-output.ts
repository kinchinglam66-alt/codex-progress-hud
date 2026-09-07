import { z } from "zod";
import { predictionSchema } from "../estimation/contracts.js";
const token=z.number().int().min(0).max(1_000_000_000);
const usageSchema=z.object({input_tokens:token,output_tokens:token,cached_input_tokens:token.optional(),
  reasoning_output_tokens:token.optional()})
  .refine(x=>x.cached_input_tokens===undefined || x.cached_input_tokens<=x.input_tokens);
const sqlSchema=z.object({sql:z.string().min(1).max(8192)}).strict();
const abstainSchema=z.object({lowSeconds:z.null(),highSeconds:z.null()}).strict();
export type CallKind="workload"|"estimator";
export type CallAnswer={sql:string}|{lowSeconds:number;highSeconds:number};
export interface CallUsage {inputTokens:number;outputTokens:number;cachedInputTokens:number|null}
export interface ControlledOutput {
  answer:CallAnswer|null;usage:CallUsage|null;
  status:"answered"|"abstained"|"invalid_answer"|"protocol_error";
}
/** Controlled fixture output only. Malformed answers do not erase valid final
 * usage. Unexpected tool execution or malformed protocol fails closed. */
export function createControlledOutputParser(kind:CallKind) {
  let buffer="",bytes=0,started=false,completed=false,failed=false,ended=false,thread=false;
  let answerText:string|undefined;
  let usage:CallUsage|null=null;
  let failureCategory:string|null=null;
  const protocolEvents:string[]=[];
  function classify(value:unknown) {
    const text=typeof value==="string"?value.slice(0,4096).toLowerCase():"";
    failureCategory=/\b403\b/.test(text)?"http_403":/\b401\b/.test(text)?"http_401":
      /usage limit|rate limit|\b429\b/.test(text)?"rate_limit":
      /model.*(not supported|not found|does not exist)/.test(text)?"unsupported_model":
      /schema/.test(text)?"schema_error":"provider_error";
  }
  const decoder=new TextDecoder("utf-8",{fatal:true});
  function line(value:string) {
    if(!value.trim())return;
    if(value.length>32768 || completed)throw Error();
    const row:unknown=JSON.parse(value);
    if(!row || typeof row!=="object" || Array.isArray(row))throw Error();
    const event=row as Record<string,unknown>;
    if(protocolEvents.length<16){
      // CLI protocol discriminator only: never message text, IDs or payloads.
      const kind=typeof event.type==="string"&&/^[a-z_]+(?:\.[a-z_]+){0,3}$/.test(event.type)&&event.type.length<=64?event.type:"invalid_type";
      protocolEvents.push(kind);
    }
    switch(event.type) {
      case "thread.started":
        if(thread || started || typeof event.thread_id!=="string")throw Error();
        thread=true;break;
      case "turn.started":
        if(started)throw Error();started=true;break;
      case "item.started":case "item.updated":case "item.completed": {
        if((!started&&!thread) || !event.item || typeof event.item!=="object")throw Error();
        const item=event.item as Record<string,unknown>;
        if(protocolEvents.length<16&&typeof item.type==="string"&&/^[a-z_]{1,48}$/.test(item.type))protocolEvents.push("item_kind."+item.type);
        if(!["agent_message","reasoning","error"].includes(String(item.type)))throw Error();
        if(event.type==="item.completed" && item.type==="agent_message") {
          if(answerText!==undefined || typeof item.text!=="string" || item.text.length>16384)throw Error();
          answerText=item.text;
        }
        break;
      }
      case "error": classify(event.message);break; // May recover; do not persist error text.
      case "turn.failed": {
        const error=event.error as {message?:unknown}|undefined;classify(error?.message);throw Error();
      }
      case "turn.completed": {
        if(!started&&!thread)throw Error();
        if(event.usage&&typeof event.usage==="object")for(const [key,value] of Object.entries(event.usage)){
          if(protocolEvents.length<16&&/^[a-z_]{1,48}$/.test(key))protocolEvents.push("usage_field."+key+"."+typeof value);
        }
        const checked=usageSchema.safeParse(event.usage);
        if(!checked.success){failureCategory="usage_shape";throw Error();}
        const value=checked.data;
        usage={inputTokens:value.input_tokens,outputTokens:value.output_tokens,cachedInputTokens:value.cached_input_tokens??null};
        completed=true;break;
      }
      default:throw Error();
    }
  }
  function consume(text:string) {
    buffer+=text;let newline;
    while((newline=buffer.indexOf("\n"))>=0) {
      const value=buffer.slice(0,newline);buffer=buffer.slice(newline+1);line(value);
    }
    if(buffer.length>32768)throw Error();
  }
  return {
    diagnostic(){return failureCategory;},
    protocolEvents(){return [...protocolEvents];},
    push(chunk:Uint8Array):boolean {
      if(ended || failed)return false;
      try {
        bytes+=chunk.byteLength;if(bytes>262144)throw Error();
        consume(decoder.decode(chunk,{stream:true}));return true;
      }catch{failed=true;buffer="";answerText=undefined;return false;}
    },
    end():ControlledOutput {
      if(!ended) {
        try{if(!failed){consume(decoder.decode());if(buffer)line(buffer);}}
        catch{failed=true;}
        ended=true;buffer="";
      }
      if(failed || !completed)return {status:"protocol_error",answer:null,usage:null};
      try {
        const value:unknown=JSON.parse(answerText??"");
        if(kind==="workload")return {status:"answered",answer:sqlSchema.parse(value),usage};
        if(abstainSchema.safeParse(value).success)return {status:"abstained",answer:null,usage};
        return {status:"answered",answer:predictionSchema.parse(value),usage};
      }catch{return {status:"invalid_answer",answer:null,usage};}
    }
  };
}
