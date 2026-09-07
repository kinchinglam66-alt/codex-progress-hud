import type {HookName} from './schema.js';

export interface PassiveContent {kind:'user'|'assistant'|'tool';text:string;truncated:boolean}
/** Local-only selection seam. No file reads, network, diagnostics or model calls. */
export function extractPassiveContent(hook:HookName,input:unknown):PassiveContent|null {
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  const value=input as Record<string,unknown>;
  let kind:PassiveContent['kind'],raw:unknown;
  if(hook==='UserPromptSubmit'){kind='user';raw=value.prompt;}
  else if(hook==='Stop'){kind='assistant';raw=value.last_assistant_message;}
  else if(hook==='PostToolUse'){
    kind='tool';
    const response=value.tool_response;
    if(typeof response==='string')raw=response;
    else if(response&&typeof response==='object'&&!Array.isArray(response)){
      const fields=response as Record<string,unknown>,parts:string[]=[];
      // Never serialize arbitrary tool payloads (environment, credentials, paths).
      for(const name of ['stdout','stderr','output','text']){
        const field=fields[name];
        if(typeof field==='string'){
          if(field.length>65536)return null;
          parts.push(`${name}: ${field}`);
        }
      }
      if(typeof fields.exit_code==='number'&&Number.isSafeInteger(fields.exit_code))parts.push(`exit_code=${fields.exit_code}`);
      raw=parts.join('\n');
    }
  }else return null;
  if(typeof raw!=='string'||raw.length>65536||!raw.trim())return null;
  // Best effort only: retain useful task text, not a promise of complete DLP.
  const filtered=raw
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,'[REDACTED KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,'[REDACTED TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [REDACTED]')
    .replace(/\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)\b["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,'$1=[REDACTED]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
  let text=filtered.slice(0,4096);
  if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
  return {kind,text,truncated:filtered.length>text.length};
}
