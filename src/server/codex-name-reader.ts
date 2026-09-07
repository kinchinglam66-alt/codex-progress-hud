import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Caller supplies a verified, metadata-only launcher. Never accepts a task command. */
export function createCodexNameReader(
  launch: () => ChildProcessWithoutNullStreams,
  options: { timeoutMs?: number } = {}
) {
  const timeoutMs=options.timeoutMs ?? 5000;
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new RangeError('Invalid name timeout');
  let disabled=false, busy=false, poison=false;
  let owned: ChildProcessWithoutNullStreams | undefined;
  const terminateOwned=() => { try { owned?.kill(); } catch { /* retain ownership until close */ } };
  let cancel: (() => void) | undefined;
  return {
    disable(): void {disabled=true;cancel?.();terminateOwned();},
    ownership(): 'idle' | 'reading' | 'termination_failed' {
      return owned === undefined ? 'idle' : poison ? 'termination_failed' : 'reading';
    },
    async read(hostId: string, signal: AbortSignal): Promise<string | null> {
      if(disabled || poison) throw Error('NAME_READER_DISABLED');
      if(busy) throw Error('NAME_READER_BUSY');
      if(signal.aborted || !hostId || hostId.length>256 || /[\x00-\x1f\x7f]/.test(hostId)) throw Error('NAME_READ_FAILED');
      busy=true;
      let child: ChildProcessWithoutNullStreams;
      try {child=launch();} catch {busy=false;throw Error('NAME_READ_FAILED');}
      owned=child;
      return new Promise<string|null>((resolve,reject)=>{
        let timer: ReturnType<typeof setTimeout>;
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        let buffer='', bytes=0, phase=0, failed=false, done=false;
        let name: string|null=null;
        const settle=(ok:boolean) => {
          if(done)return;
          done=true;clearTimeout(timer);clearTimeout(cleanupTimer);
          signal.removeEventListener('abort',abort);
          cancel=undefined;
          if(ok)resolve(name);else reject(Error('NAME_READ_FAILED'));
        };
        const stop=(failure:boolean) => {
          failed ||= failure;
          if(cleanupTimer !== undefined)return;
          if(failure) terminateOwned(); else child.stdin.end();
          cleanupTimer=setTimeout(()=>{
            terminateOwned();
            // A failed close poisons the reader; never reuse a possibly live slot.
            poison=true;settle(false);
          },1000);
        };
        const abort=()=>stop(true);
        cancel=abort;
        signal.addEventListener('abort',abort,{once:true});
        const send=(method:string,params:unknown,id?:number) => {
          if(failed || done)return;
          child.stdin.write(JSON.stringify({method,params,...(id===undefined?{}:{id})})+'\n');
        };
        child.stdin.on('error',()=>stop(true));
        child.on('error',()=>stop(true));
        child.once('close',code=>{
          if(owned===child)owned=undefined;
          busy=false;settle(code===0 && phase===2 && !failed && !signal.aborted && !disabled);
        });
        child.stderr.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>524288)stop(true);});
        child.stdout.setEncoding('utf8');
        child.stdout.on('data',(chunk:string)=>{
          if(failed || done)return;
          bytes+=Buffer.byteLength(chunk);
          if(bytes>524288){stop(true);return;}
          buffer+=chunk;
          let index:number;
          while((index=buffer.indexOf('\n'))>=0 && !failed && !done){
            const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
            if(!line.trim())continue;
            let message: {id?:unknown;method?:unknown;result?:any;error?:unknown};
            try {message=JSON.parse(line);if(!message || typeof message!=='object')throw Error();}
            catch {stop(true);return;}
            if(message.id===0 && phase===0 && message.result && !message.error){
              phase=1;send('initialized',{});send('thread/read',{threadId:hostId,includeTurns:false},1);
            } else if(message.id===1 && phase===1 && !message.error){
              const thread=message.result?.thread;
              if(thread?.id!==hostId || (thread.name!==null && thread.name!==undefined &&
                  (typeof thread.name!=='string' || thread.name.length>1024))){stop(true);return;}
              name=thread.name ?? null;phase=2;stop(false);
            } else if(message.id!==undefined){stop(true);return;}
            // Unsolicited notifications are bounded and discarded, never logged.
          }
        });
        timer=setTimeout(()=>stop(true),timeoutMs);
        if(signal.aborted)abort();
        else send('initialize',{clientInfo:{name:'codex_progress_hud_titles',version:'0.2.1'}},0);
      });
    }
  };
}
