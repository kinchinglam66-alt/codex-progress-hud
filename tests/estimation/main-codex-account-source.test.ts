import {mkdtemp,writeFile,readFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,it,expect} from 'vitest';
import {createMainCodexAccountSource} from '../../src/estimation/main-codex-account-source.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const now=2_000_000_000_000;
function credential(account='account-a',user='user-a',expiry=now/1000+600,nonce='one') {
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=encode({alg:'RS256'})+'.'+encode({sub:user,exp:expiry,nonce,
    'https://api.openai.com/auth':{chatgpt_account_id:account,chatgpt_user_id:user,chatgpt_plan_type:'plus'}})+'.synthetic';
  return {auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{account_id:account,access_token:token,refresh_token:'secret-refresh-never-forwarded'}};
}
async function fixture() {
  const home=await mkdtemp(join(tmpdir(),'hud-main-source-'));roots.push(home);
  const path=join(home,'auth.json');const original=JSON.stringify(credential());await writeFile(path,original);
  return {path,original,source:createMainCodexAccountSource({home,now:()=>now})};
}
describe('main Codex account source',()=>{
  it('inspects account metadata without exposing credentials or modifying the login cache',async()=>{
    const f=await fixture();const snapshot=await f.source.inspect();
    expect(snapshot.accountFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.expiresAt).toBe(now+600_000);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-refresh|access_token|synthetic/);
    expect(await readFile(f.path,'utf8')).toBe(f.original);
  });
  it('uses the latest same-account token for a bound session without changing its identity',async()=>{
    const f=await fixture();const first=await f.source.inspect();
    await writeFile(f.path,JSON.stringify(credential('account-a','user-a',now/1000+900,'two')));
    const next=await f.source.inspect();expect(next.accountFingerprint).toBe(first.accountFingerprint);
    const tokens=await f.source.credentials(first.accountFingerprint);
    expect(tokens.accessToken).toBe(credential('account-a','user-a',now/1000+900,'two').tokens.access_token);
    expect(Object.keys(tokens).sort()).toEqual(['accessToken','chatgptAccountId','chatgptPlanType']);
  });
  it.each([['account-b','user-a'],['account-a','user-b']])('rejects a bound session after switching to %s/%s',async(account,user)=>{
    const f=await fixture();const before=await f.source.inspect();
    const replacement=f.path+'.new';await writeFile(replacement,JSON.stringify(credential(account,user)));await rename(replacement,f.path);
    expect((await f.source.inspect()).accountFingerprint).not.toBe(before.accountFingerprint);
    await expect(f.source.credentials(before.accountFingerprint)).rejects.toThrow('MAIN_ACCOUNT_CHANGED');
  });
  it('does not reuse old credentials after logout or a partial cache write',async()=>{
    const f=await fixture();const before=await f.source.inspect();
    await writeFile(f.path,'{"tokens":');
    await expect(f.source.credentials(before.accountFingerprint)).rejects.toThrow('MAIN_ACCOUNT_UNAVAILABLE');
    await rm(f.path);await expect(f.source.inspect()).rejects.toThrow('MAIN_ACCOUNT_LOGIN_REQUIRED');
  });
  it('rejects expired tokens, contradictory account claims and API login without falling back',async()=>{
    const f=await fixture();await writeFile(f.path,JSON.stringify(credential('account-a','user-a',now/1000-1)));
    await expect(f.source.inspect()).rejects.toThrow('MAIN_ACCOUNT_REFRESH_REQUIRED');
    const mismatch=credential();mismatch.tokens.account_id='other';await writeFile(f.path,JSON.stringify(mismatch));
    await expect(f.source.inspect()).rejects.toThrow('MAIN_ACCOUNT_UNAVAILABLE');
    await writeFile(f.path,JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fake-key'}));
    await expect(f.source.inspect()).rejects.toThrow('MAIN_ACCOUNT_SUBSCRIPTION_REQUIRED');
  });
  it('honours cancellation before reading or returning credential material',async()=>{
    const f=await fixture();const controller=new AbortController();controller.abort();
    await expect(f.source.inspect(controller.signal)).rejects.toThrow('MAIN_ACCOUNT_CANCELLED');
  });
  it('bounds credential input and rejects malformed identity material without exposing it',async()=>{
    const f=await fixture();await writeFile(f.path,'x'.repeat(128*1024+1));
    await expect(f.source.inspect()).rejects.toThrow('MAIN_ACCOUNT_UNAVAILABLE');
    const broken=credential();broken.tokens.access_token='private-invalid-value';
    await writeFile(f.path,JSON.stringify(broken));
    const error=await f.source.inspect().catch(value=>value);
    expect(error.message).toBe('MAIN_ACCOUNT_UNAVAILABLE');expect(String(error)).not.toContain('private-invalid-value');
  });
});
