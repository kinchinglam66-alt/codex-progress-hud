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
it.each([true,false])('external refresh stays opt-in across the owned process boundary (%s)',async(enabled)=>{
 const p=createObserverSessionProcess({captureIdentity:async()=> 'synthetic-identity',
   ...(enabled?{onChatgptAuthTokensRefresh:async()=>({accessToken:'synthetic-access',chatgptAccountId:'synthetic-account'})}:{})});
 const childInvocation={...invocation(),args:['-e',`let b='',requestId;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='refresh-test'){requestId=m.id;process.stdout.write(JSON.stringify({id:900,method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized',previousAccountId:'synthetic-account'}})+'\\n');}else if(m.id===900){process.stdout.write(JSON.stringify({id:requestId,result:{accepted:m.result?.accessToken==='synthetic-access'&&m.result?.chatgptAccountId==='synthetic-account',denied:!!m.error}})+'\\n');}}});process.stdin.on('end',()=>process.exit(0));`]};
 try{
   const opened=await p.start(childInvocation);
   expect(await opened.rpc.call('refresh-test',{})).toEqual({accepted:enabled,denied:!enabled});
 }finally{await p.close();}
 expect(p.status()).toMatchObject({alive:false,closed:true});
});
