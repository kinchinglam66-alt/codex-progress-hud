import {spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio} from 'node:child_process';
import {isAbsolute} from 'node:path';
import type {Invocation} from './owned-process.js';
export interface HomeCheckTransportOptions {
  spawn?:(executable:string,args:string[],options:SpawnOptionsWithoutStdio)=>ChildProcessWithoutNullStreams;
}
type Timer=ReturnType<typeof setTimeout>;
interface Pending {id:number;resolve:(path:string)=>void;reject:(error:Error)=>void;signal:AbortSignal;abort:()=>void;timer:Timer}
interface Generation {
  child:ChildProcessWithoutNullStreams; stopped:boolean; closed:boolean; buffer:Buffer;
  pending:Pending|undefined; idle:Timer|undefined; cleanup:Timer|undefined;
  ended:Promise<void>; finish:()=>void;
}

/** Private fixed-operation transport. Callers must validate pinned launch assets
 * and home metadata for EVERY request. It does not authorize model execution. */
export function createHomeCheckTransport(invocation:Omit<Invocation,'input'>,expectedPath:string,options:HomeCheckTransportOptions={}) {
  if(!isAbsolute(invocation.executable)||!isAbsolute(invocation.cwd)||!expectedPath||
    invocation.args.length>256||invocation.args.some(arg=>typeof arg!=='string'||arg.includes('\0')))
    throw Error('HOME_CHECK_INVALID_LAUNCH');
  const config={...invocation,args:[...invocation.args],env:{...invocation.env}};
  const launch=options.spawn??spawn;
  let generation:Generation|undefined, disabled=false, poisoned=false, requestId=0;
  const failed=()=>Error('HOME_CHECK_FAILED');
  const settleFailure=(g:Generation)=>{
    const pending=g.pending; if(!pending)return;
    g.pending=undefined; clearTimeout(pending.timer); pending.signal.removeEventListener('abort',pending.abort);
    pending.reject(failed());
  };
  const stop=(g:Generation)=>{
    if(g.closed||g.stopped)return;
    g.stopped=true; clearTimeout(g.idle); g.idle=undefined;
    if(g.pending)clearTimeout(g.pending.timer);
    g.cleanup=setTimeout(()=>{
      poisoned=true; settleFailure(g); g.finish();
    },5000);
    try{g.child.kill();}catch{/* Retain custody until actual close or poison. */}
  };
  const start=():Generation=>{
    const child=launch(config.executable,[...config.args],{cwd:config.cwd,env:{...config.env},windowsHide:true,shell:false,stdio:'pipe'});
    let finish!:()=>void; const ended=new Promise<void>(resolve=>{finish=resolve;});
    const g:Generation={child,stopped:false,closed:false,buffer:Buffer.alloc(0),pending:undefined,idle:undefined,cleanup:undefined,ended,finish};
    generation=g;
    child.once('close',()=>{
      g.closed=true; clearTimeout(g.idle); clearTimeout(g.cleanup); settleFailure(g);
      if(generation===g)generation=undefined;
      g.finish();
    });
    const bad=()=>{if(generation===g&&!g.closed)stop(g);};
    child.on('error',bad); child.stdin.on('error',bad); child.stdout.on('error',bad); child.stderr.on('error',bad);
    child.stderr.on('data',bad);
    child.stdout.on('data',(chunk:Buffer)=>{
      if(generation!==g||g.closed||g.stopped)return;
      if(!g.pending){stop(g);return;}
      // There can be exactly one response frame, with no trailing bytes.
      if(g.buffer.length+chunk.length>4096){stop(g);return;}
      g.buffer=Buffer.concat([g.buffer,chunk]);
      const newline=g.buffer.indexOf(10); if(newline<0)return;
      if(newline!==g.buffer.length-1){stop(g);return;}
      try {
        const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(g.buffer.subarray(0,newline)));
        if(!value||typeof value!=='object'||Array.isArray(value))throw failed();
        const item=value as Record<string,unknown>;
        if(Object.keys(item).sort().join(',')!=='id,ok,path,v'||item.v!==1||item.id!==g.pending.id||item.ok!==true||item.path!==expectedPath)throw failed();
        const pending=g.pending; g.pending=undefined; g.buffer=Buffer.alloc(0);
        clearTimeout(pending.timer); pending.signal.removeEventListener('abort',pending.abort);
        g.idle=setTimeout(()=>stop(g),30000);
        pending.resolve(expectedPath);
      }catch{stop(g);}
    });
    return g;
  };
  const retire=async()=>{
    const g=generation;
    if(g){stop(g);await g.ended;}
    if(poisoned||(g&&!g.closed))throw Error('HOME_CHECK_CLOSE_UNCONFIRMED');
  };
  return {
    check(verifyOnly:boolean,signal:AbortSignal):Promise<string> {
      if(disabled||poisoned||signal.aborted||typeof verifyOnly!=='boolean'||generation?.stopped)
        return Promise.reject(Error('HOME_CHECK_UNAVAILABLE'));
      if(generation?.pending)return Promise.reject(Error('HOME_CHECK_BUSY'));
      if(requestId>=Number.MAX_SAFE_INTEGER)return Promise.reject(Error('HOME_CHECK_UNAVAILABLE'));
      const id=++requestId;
      const frame=JSON.stringify({v:1,id,op:verifyOnly?'verify':'prepare'})+'\n';
      if(Buffer.byteLength(frame)>256)return Promise.reject(Error('HOME_CHECK_UNAVAILABLE'));
      let g:Generation;
      try{g=generation??start();}catch{return Promise.reject(failed());}
      clearTimeout(g.idle); g.idle=undefined;
      return new Promise((resolve,reject)=>{
        const abort=()=>stop(g);
        g.pending={id,resolve,reject,signal,abort,timer:setTimeout(()=>stop(g),10000)};
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        try{g.child.stdin.write(frame);}catch{stop(g);}
      });
    },
    retire,
    async close(){disabled=true;await retire();},
    status:()=>({checking:generation?.pending!==undefined,resident:generation!==undefined,
      closing:generation?.stopped===true,poisoned}),
  };
}
