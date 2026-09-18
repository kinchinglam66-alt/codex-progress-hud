import {createHash} from 'node:crypto';
import {lstat,open,realpath} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import type {ChatgptAuthRefreshResult} from './observer-auth-refresh-rpc.js';

export interface MainCodexAccountSnapshot {
  accountFingerprint:string;
  expiresAt:number;
}
class MainAccountError extends Error {}
function fail(code:string):never {throw new MainAccountError(code);}
const record=(value:unknown):value is Record<string,unknown>=>
  value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&
  value.length>0&&value.length<=max&&value.trim()===value&&!/[\p{Cc}\p{Cf}]/u.test(value);
const canonical=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const identity=(stat:BigIntStats)=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,
  stat.mtimeNs,stat.ctimeNs,stat.birthtimeNs].map(String).join(':');
const MAX_BYTES=128*1024;

/** Desktop-only read access to a trusted main CODEX_HOME. Never accepts paths
 * from task text, copies refresh tokens, modifies main auth, or runs a login.
 * JWT claims here provide local binding, not remote authentication evidence.
 * The external-auth runtime/provider must still authenticate the access token.
 */
export function createMainCodexAccountSource(options:{home:string;now?:()=>number}) {
  if(!isAbsolute(options.home)||/[\x00-\x1f\x7f]/.test(options.home))fail('MAIN_ACCOUNT_UNAVAILABLE');
  const home=resolve(options.home),path=join(home,'auth.json'),now=options.now??Date.now;
  const check=(signal?:AbortSignal)=>{if(signal?.aborted)fail('MAIN_ACCOUNT_CANCELLED');};
  async function read(signal?:AbortSignal):Promise<{snapshot:MainCodexAccountSnapshot;tokens:ChatgptAuthRefreshResult}> {
    check(signal);
    try {
      if(canonical(await realpath(home))!==canonical(home))fail('MAIN_ACCOUNT_UNAVAILABLE');
      const directory=await lstat(home,{bigint:true});
      if(!directory.isDirectory()||directory.isSymbolicLink())fail('MAIN_ACCOUNT_UNAVAILABLE');
      const before=await lstat(path,{bigint:true});
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(MAX_BYTES))fail('MAIN_ACCOUNT_UNAVAILABLE');
      const file=await open(path,'r');
      let encoded:string;
      try {
        const opened=await file.stat({bigint:true});
        if(identity(before)!==identity(opened))fail('MAIN_ACCOUNT_UNAVAILABLE');
        const buffer=Buffer.alloc(MAX_BYTES+1);
        const {bytesRead}=await file.read(buffer,0,buffer.length,0);
        const after=await file.stat({bigint:true});
        const current=await lstat(path,{bigint:true});
        if(BigInt(bytesRead)!==before.size||identity(before)!==identity(after)||identity(before)!==identity(current)||
          canonical(await realpath(home))!==canonical(home))fail('MAIN_ACCOUNT_UNAVAILABLE');
        const currentDirectory=await lstat(home,{bigint:true});
        if(directory.dev!==currentDirectory.dev||directory.ino!==currentDirectory.ino||
          directory.birthtimeNs!==currentDirectory.birthtimeNs)fail('MAIN_ACCOUNT_UNAVAILABLE');
        encoded=buffer.subarray(0,bytesRead).toString('utf8');
        buffer.fill(0);
      } finally {await file.close();}
      check(signal);
      const auth:unknown=JSON.parse(encoded);
      if(!record(auth))fail('MAIN_ACCOUNT_UNAVAILABLE');
      if(auth.auth_mode!=='chatgpt'||auth.OPENAI_API_KEY)fail('MAIN_ACCOUNT_SUBSCRIPTION_REQUIRED');
      if(!record(auth.tokens)||!text(auth.tokens.account_id,256)||!text(auth.tokens.access_token,65536))fail('MAIN_ACCOUNT_UNAVAILABLE');
      const parts=auth.tokens.access_token.split('.');
      if(parts.length!==3||parts.some(part=>!part||!/^[A-Za-z0-9_-]+$/.test(part)))fail('MAIN_ACCOUNT_UNAVAILABLE');
      const claims:unknown=JSON.parse(Buffer.from(parts[1]!,'base64url').toString('utf8'));
      if(!record(claims)||!record(claims['https://api.openai.com/auth']))fail('MAIN_ACCOUNT_UNAVAILABLE');
      const scope=claims['https://api.openai.com/auth'];
      const user=scope.chatgpt_user_id??claims.sub;
      if(!text(user,512)||!text(scope.chatgpt_account_id,256)||scope.chatgpt_account_id!==auth.tokens.account_id||
        typeof claims.exp!=='number'||!Number.isSafeInteger(claims.exp)||claims.exp<=0||
        !Number.isSafeInteger(claims.exp*1000))fail('MAIN_ACCOUNT_UNAVAILABLE');
      const expiresAt=claims.exp*1000,currentTime=now();
      if(!Number.isFinite(currentTime))fail('MAIN_ACCOUNT_UNAVAILABLE');
      if(expiresAt<=currentTime)fail('MAIN_ACCOUNT_REFRESH_REQUIRED');
      const plan=scope.chatgpt_plan_type;
      if(plan!==undefined&&!text(plan,64))fail('MAIN_ACCOUNT_UNAVAILABLE');
      const accountFingerprint=createHash('sha256').update(JSON.stringify(['main-codex-account-v1',auth.tokens.account_id,user])).digest('hex');
      check(signal);
      return {snapshot:{accountFingerprint,expiresAt},tokens:{accessToken:auth.tokens.access_token,
        chatgptAccountId:auth.tokens.account_id,...(plan===undefined?{}:{chatgptPlanType:plan})}};
    } catch(error) {
      check(signal);
      if(error instanceof MainAccountError)throw error;
      if((error as NodeJS.ErrnoException)?.code==='ENOENT')fail('MAIN_ACCOUNT_LOGIN_REQUIRED');
      return fail('MAIN_ACCOUNT_UNAVAILABLE');
    }
  }
  return {
    async inspect(signal?:AbortSignal):Promise<MainCodexAccountSnapshot> {return (await read(signal)).snapshot;},
    async credentials(expectedFingerprint:string,signal?:AbortSignal):Promise<ChatgptAuthRefreshResult> {
      const current=await read(signal);
      if(!/^[a-f0-9]{64}$/.test(expectedFingerprint)||current.snapshot.accountFingerprint!==expectedFingerprint)fail('MAIN_ACCOUNT_CHANGED');
      check(signal);return current.tokens;
    },
  };
}
