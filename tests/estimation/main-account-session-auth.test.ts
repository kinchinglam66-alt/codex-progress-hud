import {expect,it} from 'vitest';
import {createMainAccountLease} from '../../src/estimation/main-account-lease.js';
import {authenticateMainAccountSession} from '../../src/estimation/main-account-session-auth.js';

function fixture(options:{remoteId?:string;loginType?:string;switchDuringCheck?:boolean;fail?:boolean;credentialsFail?:boolean;rateLimitsFail?:boolean;fallbackType?:string}={}){
 const fingerprint='a'.repeat(64);let identity=fingerprint,closed=false;
 const methods:string[]=[],listeners=new Set<(notification:{method:string;params:Record<string,unknown>})=>void>();
 const lease=createMainAccountLease({accountFingerprint:fingerprint,source:{
  inspect:async()=>({accountFingerprint:identity,expiresAt:Date.now()+600000}),
  credentials:async(expected)=>{if(options.credentialsFail)throw Error('PRIVATE_CREDENTIAL_FAILURE');if(identity!==expected)throw Error('MAIN_ACCOUNT_CHANGED');return {accessToken:'synthetic-only',chatgptAccountId:'account-a',refreshToken:'must-not-cross-boundary'};},
 }});
 const rpc={close:()=>{closed=true;},call:async(method:string,params:unknown)=>{
  methods.push(method);
  if(options.fail)throw Error('private upstream diagnostic');
  if(method==='account/login/start'){
   expect(params).toEqual({type:'chatgptAuthTokens',accessToken:'synthetic-only',chatgptAccountId:'account-a'});
   for(const listener of listeners)listener({method:'account/login/completed',params:{success:true}});
   return {type:options.loginType??'chatgptAuthTokens'};
  }
  if(method==='account/rateLimits/read'){
   if(options.rateLimitsFail)throw Error('usage endpoint unavailable');
   if(options.switchDuringCheck)identity='b'.repeat(64);
   return {accountId:options.remoteId??'account-a',rateLimits:{}};
  }
  if(method==='account/read')return {requiresOpenaiAuth:true,account:{type:options.fallbackType??'chatgpt'}};
  throw Error('unexpected RPC');
 },subscribe:(listener:(notification:{method:string;params:Record<string,unknown>})=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);}};
 return {lease,rpc,methods,closed:()=>closed};
}
it('verifies remote account identity before accepting an external login',async()=>{
 const f=fixture();try{
  await authenticateMainAccountSession(f.rpc,f.lease,new AbortController().signal);
  expect(f.methods).toEqual(['account/login/start','account/rateLimits/read']);
  expect(f.closed()).toBe(false);expect(f.lease.signal.aborted).toBe(false);
 }finally{f.lease.close();}
});
it('uses an authenticated account read when usage metadata is unavailable',async()=>{
 const f=fixture({rateLimitsFail:true});try{
  await authenticateMainAccountSession(f.rpc,f.lease,new AbortController().signal);
  expect(f.methods).toEqual(['account/login/start','account/rateLimits/read','account/read']);
  expect(f.closed()).toBe(false);expect(f.lease.signal.aborted).toBe(false);
 }finally{f.lease.close();}
});
it('rejects a non-ChatGPT fallback account',async()=>{
 const f=fixture({rateLimitsFail:true,fallbackType:'apiKey'});try{
  const error=await authenticateMainAccountSession(f.rpc,f.lease,new AbortController().signal).catch(error=>error);
  expect(error).toMatchObject({message:'MAIN_ACCOUNT_SESSION_AUTH_FAILED',code:'MAIN_AUTH_ACCOUNT_READ_FAILED'});
  expect(f.closed()).toBe(true);
 }finally{f.lease.close();}
});
it.each([{remoteId:'other'},{loginType:'chatgpt'},{switchDuringCheck:true},{fail:true}])('closes the session on failed or stale identity verification (%j)',async(options)=>{
 const f=fixture(options);try{
  await expect(authenticateMainAccountSession(f.rpc,f.lease,new AbortController().signal)).rejects.toThrow('MAIN_ACCOUNT_SESSION_AUTH_FAILED');
  expect(f.closed()).toBe(true);expect(f.lease.signal.aborted).toBe(true);
 }finally{f.lease.close();}
});
it('does not submit credentials after cancellation',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();
 await expect(authenticateMainAccountSession(f.rpc,f.lease,controller.signal)).rejects.toThrow('MAIN_ACCOUNT_SESSION_AUTH_FAILED');
 expect(f.methods).toEqual([]);expect(f.closed()).toBe(true);
});
it.each([
 [{remoteId:'other'},'MAIN_AUTH_IDENTITY_MISMATCH'],
 [{loginType:'chatgpt'},'MAIN_AUTH_LOGIN_FAILED'],
 [{switchDuringCheck:true},'MAIN_AUTH_REVALIDATION_FAILED'],
 [{fail:true},'MAIN_AUTH_LOGIN_FAILED'],
 [{credentialsFail:true},'MAIN_AUTH_CREDENTIALS_FAILED'],
] as const)('keeps a bounded authentication stage without private causes (%j)',async(options,code)=>{
 const f=fixture(options);try{
  const error=await authenticateMainAccountSession(f.rpc,f.lease,new AbortController().signal).catch(error=>error);
  expect(error).toMatchObject({message:'MAIN_ACCOUNT_SESSION_AUTH_FAILED',code});
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toMatch(/private upstream|synthetic-only|account-a|PRIVATE_CREDENTIAL_FAILURE/);
 }finally{f.lease.close();}
});
