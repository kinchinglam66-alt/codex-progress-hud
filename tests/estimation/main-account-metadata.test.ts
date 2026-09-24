import {expect,it,vi} from 'vitest';
import {createMainAccountMetadataReader} from '../../src/estimation/main-account-metadata.js';
import {createObserverSessionProcess} from '../../src/estimation/observer-session-process.js';
import {createMainAccountLease} from '../../src/estimation/main-account-lease.js';
import {preparationErrorCode} from '../../src/estimation/observer-persistent-receipt.js';
const config={model_provider:'openai',forced_login_method:'chatgpt',cli_auth_credentials_store:'ephemeral',chatgpt_base_url:'https://chatgpt.com/backend-api/',model_providers:{}};
it('prioritizes unconfirmed cleanup over a failed metadata step and retains the poison fence',async()=>{
 const script=`let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`;
 const reader=createMainAccountMetadataReader({invocation:{executable:process.execPath,args:['-e',script],cwd:process.cwd(),env:process.env,input:''},
  source:{inspect:async()=>({accountFingerprint:'a'.repeat(64),expiresAt:Date.now()+600000}),credentials:async()=>{throw Error('unused');}},
  processFactory:options=>{const owner=createObserverSessionProcess({...options,captureIdentity:async()=> 'synthetic'});
   return {...owner,close:async()=>{await owner.close();throw Error('PRIVATE_CLEANUP_FAILURE');}};}});
 try{
  const error=await reader.read(new AbortController().signal).catch(error=>error);
  expect(error.message).toBe('MAIN_ACCOUNT_METADATA_CLOSE_UNCONFIRMED');
  expect(preparationErrorCode(error)).toBe('MAIN_METADATA_CLOSE_UNCONFIRMED');
  expect(reader.ownership()).toBe('termination_failed');
  await expect(reader.read(new AbortController().signal)).rejects.toThrow('MAIN_ACCOUNT_METADATA_UNAVAILABLE');
  expect(JSON.stringify(error)).not.toContain('PRIVATE_CLEANUP_FAILURE');
 }finally{reader.disable();}
});
it.each(['timeout','cancel','disable'] as const)('distinguishes metadata %s without starting a process',async mode=>{
 vi.useFakeTimers();let starts=0;const controller=new AbortController();
 const reader=createMainAccountMetadataReader({invocation:{executable:'unused',args:[],cwd:process.cwd(),env:{},input:''},
  source:{inspect:signal=>new Promise((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(Error('PRIVATE_ABORT')),{once:true});}),
   credentials:async()=>{throw Error('must not read credentials');}},
  processFactory:()=>{starts++;throw Error('must not start');}});
 try{
  const result=reader.read(controller.signal).catch(error=>error);
  if(mode==='timeout')await vi.advanceTimersByTimeAsync(15000);
  else if(mode==='cancel')controller.abort();else reader.disable();
  const error=await result;
  expect(error).toMatchObject({message:'MAIN_ACCOUNT_METADATA_UNAVAILABLE',code:mode==='timeout'?'MAIN_METADATA_TIMEOUT':'MAIN_METADATA_CANCELLED'});
  expect(starts).toBe(0);expect(reader.ownership()).toBe('idle');
  expect(JSON.stringify(error)).not.toContain('PRIVATE_ABORT');
  expect(vi.getTimerCount()).toBe(0);
 }finally{reader.disable();vi.useRealTimers();}
});
it.each([
 ['config/read','MAIN_METADATA_ROUTE_FAILED'],
 ['account/login/start','MAIN_AUTH_LOGIN_FAILED'],
 ['account/read','MAIN_METADATA_ACCOUNT_READ_FAILED'],
] as const)('preserves safe %s failure across auth, metadata and receipt classification',async(failMethod,code)=>{
 const script=`let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(!m.id)continue;if(m.method===${JSON.stringify(failMethod)}){process.stdout.write(JSON.stringify({id:m.id,error:{code:-1,message:'PRIVATE_RPC_CONTENT'}})+'\\n');continue;}let result={};if(m.method==='config/read')result={config:${JSON.stringify(config)}};else if(m.method==='account/login/start')result={type:'chatgptAuthTokens'};else if(m.method==='account/rateLimits/read')result={accountId:'a',rateLimits:{}};else if(m.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:'synthetic@example.invalid'}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`;
 const reader=createMainAccountMetadataReader({invocation:{executable:process.execPath,cwd:process.cwd(),env:process.env,args:['-e',script],input:''},
  source:{inspect:async()=>({accountFingerprint:'a'.repeat(64),expiresAt:Date.now()+600000}),credentials:async()=>({accessToken:'synthetic',chatgptAccountId:'a'})},
  processFactory:options=>createObserverSessionProcess({...options,captureIdentity:async()=> 'synthetic'})});
 try{
  const error=await reader.read(new AbortController().signal).catch(error=>error);
  expect(error).toMatchObject({message:'MAIN_ACCOUNT_METADATA_UNAVAILABLE',code});
  expect(preparationErrorCode(error)).toBe(code);
  expect(error.cause).toBeUndefined();expect(JSON.stringify(error)).not.toContain('PRIVATE_RPC_CONTENT');
  expect(reader.ownership()).toBe('idle');
 }finally{reader.disable();}
});
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
