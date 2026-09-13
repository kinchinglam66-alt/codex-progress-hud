import {expect,it} from 'vitest';
import {createObserverSessionProcess} from '../../src/estimation/observer-session-process.js';
const invocation=()=>({executable:process.execPath,cwd:process.cwd(),env:process.env,input:'',args:['-e',`let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{echo:m.params}})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`]});
it('owns one process across multiple RPC operations, then confirms explicit closure',async()=>{
 const p=createObserverSessionProcess({captureIdentity:async()=> 'synthetic-identity'});
 try{
   const opened=await p.start(invocation());
   expect(await opened.rpc.call('echo',{a:1})).toEqual({echo:{a:1}});
   expect(await opened.rpc.call('echo',{a:2})).toEqual({echo:{a:2}});
   expect(p.status()).toMatchObject({alive:true,closed:false});
   await expect(p.start(invocation())).rejects.toThrow();
 }finally{await p.close();}
 expect(p.status()).toMatchObject({alive:false,closed:true});
});
it('fails closed when process creation identity cannot be captured',async()=>{
 const p=createObserverSessionProcess({captureIdentity:async()=>null});
 await expect(p.start(invocation())).rejects.toThrow('SESSION_PROCESS_IDENTITY');
 await p.close();expect(p.status().closed).toBe(true);
});
it('cannot start after disable, including before first launch',async()=>{
 const p=createObserverSessionProcess();p.disable();
 await expect(p.start(invocation())).rejects.toThrow('SESSION_PROCESS_DISABLED');await p.close();
});
