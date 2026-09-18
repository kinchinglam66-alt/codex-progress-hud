import {expect,it} from 'vitest';
import {createMainAccountMetadataReader} from '../../src/estimation/main-account-metadata.js';
import {createObserverSessionProcess} from '../../src/estimation/observer-session-process.js';
import {createMainAccountLease} from '../../src/estimation/main-account-lease.js';
const config={model_provider:'openai',forced_login_method:'chatgpt',cli_auth_credentials_store:'ephemeral',chatgpt_base_url:'https://chatgpt.com/backend-api/',model_providers:{}};
it.each([false,true])('attests isolated main-account metadata and rejects route changes (%s)',async(changed)=>{
 const script=`let b='',reads=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(!m.id)continue;let result={};if(m.method==='account/login/start')result={type:'chatgptAuthTokens'};else if(m.method==='account/rateLimits/read')result={accountId:'a',rateLimits:{}};else if(m.method==='account/read')result={account:{type:'chatgpt',email:'synthetic@example.invalid',planType:'plus'},requiresOpenaiAuth:true};else if(m.method==='config/read'){let config=${JSON.stringify(config)};if(++reads===2&&${changed})config.chatgpt_base_url='https://relay.invalid';result={config};}process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`;
 let owner:ReturnType<typeof createObserverSessionProcess>|undefined;
 const reader=createMainAccountMetadataReader({invocation:{executable:process.execPath,cwd:process.cwd(),env:process.env,args:['-e',script],input:''},
  source:{inspect:async()=>({accountFingerprint:'a'.repeat(64),expiresAt:Date.now()+600000}),credentials:async()=>({accessToken:'synthetic',chatgptAccountId:'a'})},
  processFactory:options=>{owner=createObserverSessionProcess({...options,captureIdentity:async()=> 'synthetic'});return owner;},
 });
 try{
  if(changed)await expect(reader.read(new AbortController().signal)).rejects.toThrow('MAIN_ACCOUNT_METADATA_UNAVAILABLE');
  else{
   const result=await reader.read(new AbortController().signal);
   expect(result).toMatchObject({accountFingerprint:'a'.repeat(64),accountLabel:'synthetic@example.invalid'});
   expect(result.routeFingerprint).toMatch(/^[a-f0-9]{64}$/);
   expect(JSON.stringify(result)).not.toContain('accessToken');
  }
  expect(owner?.status().closed).toBe(true);expect(reader.ownership()).toBe('idle');
 }finally{reader.disable();}
});
it.each(['success','binding','invocation','cancel'] as const)('borrows initialized worker transport with caller-owned cleanup (%s)',async(mode)=>{
 const script=`let b='',initialized=false;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(!m.id)continue;let result={};if(m.method==='initialize'){if(initialized){process.stdout.write(JSON.stringify({id:m.id,error:{code:-1,message:'duplicate initialize'}})+'\\n');continue;}initialized=true;}else if(m.method==='account/login/start')result={type:'chatgptAuthTokens'};else if(m.method==='account/rateLimits/read')result={accountId:'a',rateLimits:{}};else if(m.method==='account/read')result={account:{type:'chatgpt',email:'synthetic@example.invalid'},requiresOpenaiAuth:true};else if(m.method==='config/read')result={config:${JSON.stringify(config)}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`;
 const invocation={executable:process.execPath,cwd:process.cwd(),env:process.env,args:['-e',script],input:''};
 const source={inspect:async()=>({accountFingerprint:'a'.repeat(64),expiresAt:Date.now()+600000}),credentials:async()=>({accessToken:'synthetic',chatgptAccountId:'a'})};
 const lease=createMainAccountLease({source,accountFingerprint:(mode==='binding'?'b':'a').repeat(64)});
 const owner=createObserverSessionProcess({captureIdentity:async()=> 'synthetic',onChatgptAuthTokensRefresh:lease.refresh});
 const opened=await owner.start(invocation);
 const transport={...opened,invocation:mode==='invocation'?{...invocation}:invocation,lease};
 const controller=new AbortController();
 await opened.rpc.call('initialize',{});opened.rpc.notify('initialized',{});
 const reader=createMainAccountMetadataReader({invocation,source,
  processFactory:()=>{throw Error('second process forbidden');},
  openMainAccountSession:async()=>{if(mode==='cancel')controller.abort();return transport;},
 });
 try{
  if(mode==='success'){
   const result=await reader.read(controller.signal);
   expect(result.mainAccountSession).toBe(transport);
   expect(result.accountFingerprint).toBe('a'.repeat(64));
   reader.disable();
   expect(owner.status().alive).toBe(true);
   expect(await lease.validate()).toBe(true);
  }else{
   await expect(reader.read(controller.signal)).rejects.toThrow('MAIN_ACCOUNT_METADATA_UNAVAILABLE');
   await expect(opened.rpc.call('account/read',{})).rejects.toThrow();
  }
  expect(reader.ownership()).toBe('idle');
 }finally{reader.disable();lease.close();await owner.close();}
 expect(owner.status().closed).toBe(true);
});
