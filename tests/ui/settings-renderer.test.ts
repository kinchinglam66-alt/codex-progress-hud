import {afterEach,expect,it,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});

it('edits subscription capacity without requiring login or a new secret',async()=>{
  const listeners=new Map<string,()=>void>(),elements=new Map<string,any>();
  for(const id of ['#state','#known-tokens','#unknown-count','#message','#check','#recover','#revoke',
    '#provider-source','#provider-save','#context-model','#context-tokens','#context-output-reserve','#context-request-bytes'])
    elements.set(id,{textContent:'',value:'',disabled:false,addEventListener:(type:string,fn:()=>void)=>listeners.set(id+':'+type,fn)});
  const contextCapacity={model:'test-model',contextTokens:100000,outputReserveTokens:4096,requestBytes:null};
  const draft={selected:'subscription',api:null,contextCapacity};
  const snapshot={generation:1,revision:1,selected:'subscription',state:'ready',active:draft,draft,keyConfigured:false};
  const saveProviderSettings=vi.fn(async(_payload:unknown)=>snapshot);
  vi.stubGlobal('document',{querySelector:(id:string)=>elements.get(id)});
  vi.stubGlobal('window',{codexProgressHudSettings:{getStatus:async()=>({state:'normal',revision:1,knownTokens:0,unknown:0,recoveryAllowed:false}),
    readProviderSettings:async()=>snapshot,saveProviderSettings}});
  await import('../../src/ui/settings-renderer.js');
  await vi.waitFor(()=>expect(elements.get('#context-tokens').value).toBe('100000'));
  elements.get('#context-tokens').value='200000';
  listeners.get('#provider-save:click')!();
  await vi.waitFor(()=>expect(saveProviderSettings).toHaveBeenCalled());
  expect(saveProviderSettings.mock.calls[0]?.[0]).toMatchObject({draft:{...draft,contextCapacity:{...contextCapacity,contextTokens:200000}}});
});

it('explains unresolved previous calls before and after a denied recovery check',async()=>{
  const listeners=new Map<string,()=>void>(), elements=new Map<string,any>();
  for(const id of ['#state','#known-tokens','#unknown-count','#message','#check','#recover','#revoke'])
    elements.set(id,{textContent:'',disabled:false,addEventListener:(_type:string,listener:()=>void)=>listeners.set(id,listener)});
  const status={state:'blocked',reason:'unresolved_previous_call',revision:0,knownTokens:12,unknown:0,recoveryAllowed:false};
  vi.stubGlobal('document',{querySelector:(id:string)=>elements.get(id)});
  vi.stubGlobal('window',{codexProgressHudSettings:{getStatus:async()=>status,preflight:async()=>({...status,allowed:false})}});
  await import('../../src/ui/settings-renderer.js');
  await vi.waitFor(()=>expect(elements.get('#message').textContent).toContain('自动检查'));
  expect(elements.get('#message').textContent).not.toContain('重启');
  expect(elements.get('#message').textContent).not.toContain('额度');
  listeners.get('#check')!();
  await Promise.resolve();await Promise.resolve();
  expect(elements.get('#message').textContent).toContain('自动检查');
  expect(elements.get('#message').textContent).not.toContain('重启');
  expect(elements.get('#recover').disabled).toBe(true);
});

it.each([['unknown','尚未检查'],['unavailable','检查失败'],['signed_out','未登录']])('renders account status %s without inferring sign-out from missing metadata',async(accountStatus,expected)=>{
  const elements=new Map<string,any>();
  for(const id of ['#state','#known-tokens','#unknown-count','#message','#check','#recover','#revoke','#provider-account','#provider-start'])elements.set(id,{textContent:'',disabled:false,addEventListener:()=>{}});
  vi.stubGlobal('document',{querySelector:(id:string)=>elements.get(id)});
  vi.stubGlobal('window',{codexProgressHudSettings:{getStatus:async()=>({state:'normal',revision:0,knownTokens:0,unknown:0,recoveryAllowed:false}),readProviderSettings:async()=>({generation:0,revision:0,state:'inactive',selected:'subscription',active:{selected:'subscription',api:null},draft:{selected:'subscription',api:null},account:null,accountStatus})}});
  await import('../../src/ui/settings-renderer.js');
  await vi.waitFor(()=>expect(elements.get('#provider-account').textContent).toContain(expected));
  if(accountStatus!=='signed_out')expect(elements.get('#provider-start').textContent).not.toContain('登录');
});

it.each(['delayed','rejected'])('keeps post-activation refresh truthful when an earlier read is %s', async(kind)=>{
  const listeners=new Map<string,()=>void>();const elements=new Map<string,any>();
  for(const id of ['#state','#known-tokens','#unknown-count','#message','#check','#recover','#revoke','#provider-activate'])
    elements.set(id,{textContent:'',disabled:false,addEventListener:(_type:string,fn:()=>void)=>listeners.set(id,fn)});
  let release!:(value:unknown)=>void;
  const pending=new Promise(resolve=>{release=resolve;});let reads=0;
  const status=(state:string)=>({state,revision:1,knownTokens:0,unknown:0,recoveryAllowed:false});
  const snapshot={generation:1,revision:1,selected:'subscription',state:'ready',active:{selected:'subscription',api:null},draft:{selected:'subscription',api:null},keyConfigured:false};
  vi.stubGlobal('document',{querySelector:(id:string)=>elements.get(id)});
  vi.stubGlobal('window',{codexProgressHudSettings:{getStatus:async()=>{reads++;if(reads===1)return kind==='delayed'?pending:status('unauthorized');if(kind==='rejected')throw Error('PRIVATE');return status('normal');},readProviderSettings:async()=>snapshot,activateProvider:async()=>snapshot}});
  await import('../../src/ui/settings-renderer.js');
  listeners.get('#provider-activate')!();
  await vi.waitFor(()=>expect(elements.get('#provider-activate').disabled).toBe(false));
  if(kind==='delayed'){
    release(status('unauthorized'));await new Promise(resolve=>setTimeout(resolve,0));
    expect(elements.get('#state').textContent).toBe('normal');
  }else{
    expect(elements.get('#message').textContent).toContain('刷新失败');
    expect(elements.get('#message').textContent).not.toBe('提供方已启用。');
  }
});

it('does not describe a healthy recovery check as disabled and refreshes status after activation', async()=>{
  const listeners=new Map<string,()=>void>();
  const elements=new Map<string,any>();
  for(const id of ['#state','#known-tokens','#unknown-count','#message','#check','#recover','#revoke','#provider-activate'])
    elements.set(id,{textContent:'',disabled:false,addEventListener:(_type:string,fn:()=>void)=>listeners.set(id,fn)});
  let current='normal';
  const status=()=>({state:current,revision:1,knownTokens:0,unknown:0,recoveryAllowed:false});
  const snapshot={generation:1,revision:1,selected:'subscription',state:'ready',active:{selected:'subscription',api:null},draft:{selected:'subscription',api:null},keyConfigured:false};
  vi.stubGlobal('document',{querySelector:(id:string)=>elements.get(id)});
  vi.stubGlobal('window',{codexProgressHudSettings:{getStatus:async()=>status(),preflight:async()=>({...status(),allowed:false}),readProviderSettings:async()=>snapshot,activateProvider:async()=>{current='normal';return snapshot;}}});
  await import('../../src/ui/settings-renderer.js');
  listeners.get('#check')!();
  await vi.waitFor(()=>expect(elements.get('#message').textContent).toContain('无需恢复'));
  expect(elements.get('#message').textContent).not.toContain('停用');
  current='unauthorized';listeners.get('#check')!();
  await vi.waitFor(()=>expect(elements.get('#state').textContent).toBe('unauthorized'));
  listeners.get('#provider-activate')!();
  await vi.waitFor(()=>expect(elements.get('#state').textContent).toBe('normal'));
  expect(elements.get('#message').textContent).not.toContain('未通过');
});

it('keeps one-step actions visible while legacy recovery and provider controls start collapsed', async()=>{
  const html=await readFile(resolve('src/ui/settings.html'),'utf8');
  expect(html).toContain('<button id="provider-start"');
  expect(html).toContain('<details id="recovery-advanced">');
  expect(html).toContain('<details id="provider-advanced">');
  expect(html).not.toContain('<details id="recovery-advanced" open');
  expect(html).not.toContain('<details id="provider-advanced" open');
  expect(html.indexOf('id="provider-heading"')).toBeLessThan(html.indexOf('id="status-heading"'));
  expect(html.indexOf('id="provider-cancel"')).toBeLessThan(html.indexOf('<details id="provider-advanced">'));
  expect(html).toContain('id="api-max-output-tokens" type="number" min="1" value="2048"');
  expect(html).toContain('id="api-daily-call-limit" type="number" min="1" value="24"');
});

it('renders the live API disclosure and produces a valid fresh API start from URL/model/key only', async()=>{
  const listeners=new Map<string,(event?:unknown)=>void>();
  const elements=new Map<string,any>();
  const selectors=['#state','#known-tokens','#unknown-count','#message','#diagnostic','#check','#recover','#revoke','#provider-source','#api-profile-id','#api-name','#api-base-url','#api-model','#api-protocol','#api-reasoning-effort','#api-max-output-tokens','#api-daily-call-limit','#api-key','#api-key-state','#provider-dirty','#provider-account','#provider-account-time','#provider-recipient','#provider-usage-notice','#provider-api-fields','#provider-start','#provider-consent','#provider-save','#provider-check','#provider-trial','#provider-activate','#provider-cancel','#subscription-login','#subscription-device-login','#subscription-logout'];
  for(const selector of selectors){
    const defaults:Record<string,string>={'#provider-source':'subscription','#api-profile-id':'default','#api-name':'','#api-base-url':'','#api-model':'','#api-protocol':'responses','#api-reasoning-effort':'medium','#api-max-output-tokens':'','#api-daily-call-limit':'','#api-key':''};
    elements.set(selector,{textContent:'',disabled:false,value:defaults[selector]??'',hidden:false,checked:false,addEventListener:(type:string,listener:(event?:unknown)=>void)=>listeners.set(`${selector}:${type}`,listener)});
  }
  const snapshot={generation:2,revision:3,selected:'subscription',state:'inactive',active:{selected:'subscription',api:null},draft:{selected:'subscription',api:null},keyConfigured:false,account:null,recipient:'Codex Progress HUD observer'};
  const api={getStatus:async()=>({state:'normal',revision:1,knownTokens:0,unknown:0,recoveryAllowed:false}),readProviderSettings:vi.fn(async()=>snapshot),startProvider:vi.fn(async()=>snapshot),saveProviderSettings:vi.fn(async()=>snapshot)};
  vi.stubGlobal('document',{querySelector:(selector:string)=>elements.get(selector)});
  vi.stubGlobal('window',{codexProgressHudSettings:api});
  await import('../../src/ui/settings-renderer.js');
  await vi.waitFor(()=>expect(api.readProviderSettings).toHaveBeenCalled());
  const source=elements.get('#provider-source'); source.value='api'; listeners.get('#provider-source:change')!({target:source});
  expect(elements.get('#provider-api-fields').hidden).toBe(false);
  expect(elements.get('#provider-start').textContent).toBe('保存并开始');
  const base=elements.get('#api-base-url'); base.value='https://fresh.example.test/v1'; listeners.get('#api-base-url:input')!({target:base});
  const model=elements.get('#api-model'); model.value='fresh-model'; listeners.get('#api-model:input')!({target:model});
  expect(elements.get('#provider-recipient').textContent).toContain('fresh.example.test/v1 · fresh-model');
  expect(elements.get('#provider-usage-notice').textContent).toContain('可能产生费用');
  elements.get('#provider-consent').checked=true;
  const key=elements.get('#api-key'); key.value='write-only-key'; listeners.get('#api-key:input')!({target:key});
  expect(elements.get('#provider-consent').checked).toBe(false);
  elements.get('#provider-consent').checked=true; listeners.get('#provider-start:click')!();
  await vi.waitFor(()=>expect(api.startProvider).toHaveBeenCalledOnce());
  const payload=(api.startProvider as any).mock.calls[0][0] as any;
  expect(payload.draft).toMatchObject({selected:'api',api:{profileId:'default',name:'OpenAI API',baseUrl:'https://fresh.example.test/v1',protocol:'responses',model:'fresh-model',reasoningEffort:'medium',maxOutputTokens:2048,dailyCallLimit:24}});
  expect(payload.secret).toBe('write-only-key');
});

it('derives subscription disclosure independently when leaving a saved API draft', async()=>{
  const listeners=new Map<string,(event?:unknown)=>void>();
  const elements=new Map<string,any>();
  const selectors=['#state','#known-tokens','#unknown-count','#message','#diagnostic','#check','#recover','#revoke','#provider-source','#api-profile-id','#api-name','#api-base-url','#api-model','#api-protocol','#api-reasoning-effort','#api-max-output-tokens','#api-daily-call-limit','#api-key','#api-key-state','#provider-dirty','#provider-account','#provider-account-time','#provider-recipient','#provider-usage-notice','#provider-api-fields','#provider-start','#provider-consent','#provider-save','#provider-check','#provider-trial','#provider-activate','#provider-cancel','#subscription-login','#subscription-device-login','#subscription-logout'];
  for(const selector of selectors){
    const defaults:Record<string,string>={'#provider-source':'subscription','#api-profile-id':'default','#api-name':'','#api-base-url':'','#api-model':'','#api-protocol':'responses','#api-reasoning-effort':'medium','#api-max-output-tokens':'','#api-daily-call-limit':'','#api-key':''};
    elements.set(selector,{textContent:'',disabled:false,value:defaults[selector]??'',hidden:false,checked:false,addEventListener:(type:string,listener:(event?:unknown)=>void)=>listeners.set(`${selector}:${type}`,listener)});
  }
  const snapshot={generation:4,revision:5,selected:'api',state:'ready',active:{selected:'api',api:null},draft:{selected:'api',api:{profileId:'saved',name:'Saved API',baseUrl:'https://saved.example.test/v1',protocol:'responses',model:'saved-model',reasoningEffort:'medium',maxOutputTokens:2048,dailyCallLimit:24,keyConfigured:true}},keyConfigured:true,account:null,recipient:'https://saved.example.test/v1 · saved-model'};
  const api={getStatus:async()=>({state:'normal',revision:1,knownTokens:0,unknown:0,recoveryAllowed:false}),readProviderSettings:vi.fn(async()=>snapshot),startProvider:vi.fn(async()=>snapshot)};
  vi.stubGlobal('document',{querySelector:(selector:string)=>elements.get(selector)});
  vi.stubGlobal('window',{codexProgressHudSettings:api});
  await import('../../src/ui/settings-renderer.js');
  await vi.waitFor(()=>expect(api.readProviderSettings).toHaveBeenCalled());
  const source=elements.get('#provider-source');
  const consent=elements.get('#provider-consent');
  consent.checked=true;
  source.value='subscription'; listeners.get('#provider-source:change')!({target:source});
  expect(elements.get('#provider-recipient').textContent).toBe('OpenAI / ChatGPT 订阅账户');
  expect(elements.get('#provider-usage-notice').textContent).toContain('订阅估时会消耗');
  expect(elements.get('#provider-usage-notice').textContent).not.toContain('saved.example.test');
  expect(elements.get('#provider-start').textContent).toBe('检查账户并开始');
  expect(elements.get('#provider-api-fields').hidden).toBe(true);
  expect(consent.checked).toBe(false);
  consent.checked=true; listeners.get('#provider-start:click')!();
  await vi.waitFor(()=>expect(api.startProvider).toHaveBeenCalledOnce());
  expect((api.startProvider as any).mock.calls[0][0]).toMatchObject({selected:'subscription',consent:true});
});

it('allows Cancel during a pending provider action and does not overwrite its result', async () => {
  const listeners = new Map<string, () => void>();
  const elements = new Map<string, {textContent:string; disabled:boolean; value:string; addEventListener:(type:string,callback:()=>void)=>void}>();
  for (const id of ['#state','#known-tokens','#unknown-count','#message','#check','#recover','#revoke','#provider-check','#provider-cancel']) {
    elements.set(id,{textContent:'',disabled:false,value:'',addEventListener:(_type,callback)=>listeners.set(id,callback)});
  }
  let release!: () => void;
  const pending = new Promise<void>(resolve => {release=resolve;});
  const api = {getStatus:async()=>({state:'normal',revision:1,knownTokens:0,unknown:0,recoveryAllowed:false}),
    readProviderSettings:async()=>({generation:1,revision:1,selected:'api',state:'inactive',active:{selected:'api',api:null},draft:{selected:'api',api:null},keyConfigured:false}),
    checkProvider:vi.fn(async()=>{await pending; return {ok:true};}), cancelProviderAction:vi.fn(async()=>{release();})};
  vi.stubGlobal('document',{querySelector:(selector:string)=>elements.get(selector)});
  vi.stubGlobal('window',{codexProgressHudSettings:api});
  await import('../../src/ui/settings-renderer.js');
  listeners.get('#provider-check')!();
  await vi.waitFor(()=>expect(api.checkProvider).toHaveBeenCalledOnce());
  expect(elements.get('#provider-cancel')!.disabled).toBe(false);
  listeners.get('#provider-cancel')!(); listeners.get('#provider-cancel')!();
  await vi.waitFor(()=>expect(api.cancelProviderAction).toHaveBeenCalledOnce());
  await vi.waitFor(()=>expect(elements.get('#message')!.textContent).toContain('已取消'));
  expect(elements.get('#provider-cancel')!.disabled).toBe(true);
});
it('keeps recovery failure visible after refreshing status and renders bounded stage details',async()=>{
  const listeners=new Map<string,()=>void>();
  const elements=new Map<string,{textContent:string;disabled:boolean;addEventListener:(type:string,listener:()=>void)=>void}>();
  for(const selector of ['#state','#known-tokens','#unknown-count','#message','#diagnostic','#check','#recover','#revoke'])
    elements.set(selector,{textContent:'',disabled:false,addEventListener:(_type,listener)=>listeners.set(selector,listener)});
  const status={state:'blocked',revision:1,knownTokens:0,unknown:3,recoveryAllowed:true,
    lastDiagnostic:{stage:'trial',outcome:'failed',usagePresent:false,closureConfirmed:true,callReason:'missing_usage',processReason:'exited',exitCode:7,parserError:'protocol',elapsedMs:123,errorCategories:['http_403']}};
  vi.stubGlobal('document',{querySelector:(selector:string)=>elements.get(selector)});
  vi.stubGlobal('window',{codexProgressHudSettings:{getStatus:async()=>status,
    preflight:async()=>({...status,allowed:true,challenge:'challenge'}),confirm:async()=>{throw Error('PRIVATE_ERROR');}}});
  await import('../../src/ui/settings-renderer.js');
  listeners.get('#check')!();
  await vi.waitFor(()=>expect(elements.get('#recover')?.disabled).toBe(false));
  listeners.get('#recover')!();
  await vi.waitFor(()=>expect(elements.get('#message')?.textContent).toContain('不会自动重试'));
  expect(elements.get('#diagnostic')?.textContent).toContain('trial');
  expect(elements.get('#diagnostic')?.textContent).toContain('未返回');
  expect(elements.get('#diagnostic')?.textContent).toContain('missing_usage');
  expect(elements.get('#diagnostic')?.textContent).toContain('http_403');
  expect(elements.get('#diagnostic')?.textContent).toContain('退出码 7');
  expect(elements.get('#diagnostic')?.textContent).not.toContain('进程退出已确认');
  expect(elements.get('#message')?.textContent).not.toContain('PRIVATE_ERROR');
});
it('shows cooldown and its next eligible time rather than claiming permanent disable after a check',async()=>{
  const listeners=new Map<string,()=>void>();
  const elements=new Map<string,{textContent:string;disabled:boolean;addEventListener:(type:string,listener:()=>void)=>void}>();
  for(const selector of ['#state','#known-tokens','#unknown-count','#message','#check','#recover','#revoke'])
    elements.set(selector,{textContent:'',disabled:false,addEventListener:(_type,listener)=>{listeners.set(selector,listener);}});
  const status={state:'cooldown',revision:1,knownTokens:0,unknown:3,recoveryAllowed:false,nextEligibleAt:1788955200000};
  vi.stubGlobal('document',{querySelector:(selector:string)=>elements.get(selector)});
  vi.stubGlobal('window',{codexProgressHudSettings:{getStatus:async()=>status,preflight:async()=>({...status,allowed:false})}});
  await import('../../src/ui/settings-renderer.js');
  await vi.waitFor(()=>expect(elements.get('#state')?.textContent).toBe('冷却中'));
  listeners.get('#check')!();
  await vi.waitFor(()=>expect(elements.get('#message')?.textContent).toMatch(/下次可尝试：.*\d{2}:\d{2}:\d{2}/u));
  expect(elements.get('#message')?.textContent).not.toContain('保持停用');
});
it.each([
  ['success','估时授权已撤销。'],
  ['cancel','已取消撤销，授权未更改。'],
  ['failure','撤销未完成；保存的授权记录可能仍然存在，请检查状态并重试。']
])('reports revocation %s without claiming the opposite permission state',async(kind,message)=>{
  const listeners=new Map<string,()=>void>();
  const elements=new Map<string,{textContent:string;disabled:boolean;addEventListener:(type:string,listener:()=>void)=>void}>();
  for(const selector of ['#state','#known-tokens','#unknown-count','#message','#check','#recover','#revoke'])
    elements.set(selector,{textContent:'',disabled:false,addEventListener:(_type,listener)=>{listeners.set(selector,listener);}});
  const status={state:'normal',revision:1,knownTokens:0,unknown:0,recoveryAllowed:false};
  const api={getStatus:vi.fn(async()=>status),preflight:vi.fn(),confirm:vi.fn(),
    revokeConsent:vi.fn(async()=>{if(kind==='failure')throw Error('PRIVATE_STORAGE_ERROR');return {...status,consentRevoked:kind==='success'};})};
  vi.stubGlobal('document',{querySelector:(selector:string)=>elements.get(selector)});
  vi.stubGlobal('window',{codexProgressHudSettings:api});
  await import('../../src/ui/settings-renderer.js');
  listeners.get('#revoke')!();
  await vi.waitFor(()=>expect(elements.get('#message')?.textContent).toBe(message));
  expect(elements.get('#revoke')?.disabled).toBe(false);
  expect(api.revokeConsent).toHaveBeenCalledOnce();
});

it('renders provider source/account/key state, marks dirty drafts, clears secrets, and reports cancelled login',async()=>{
  const listeners=new Map<string,(event?:unknown)=>void>();
  const values=new Map<string,string>();
  const elements=new Map<string,{textContent:string;disabled:boolean;value:string;hidden:boolean;addEventListener:(type:string,listener:(event?:unknown)=>void)=>void}>();
  for(const selector of ['#state','#known-tokens','#unknown-count','#message','#diagnostic','#check','#recover','#revoke','#provider-source','#api-profile-id','#api-name','#api-base-url','#api-model','#api-protocol','#api-key','#api-key-state','#provider-dirty','#provider-account','#provider-account-time','#provider-recipient','#provider-save','#provider-check','#provider-trial','#provider-activate','#subscription-login','#subscription-device-login','#subscription-logout','#provider-cancel'])
    elements.set(selector,{textContent:'',disabled:false,value:values.get(selector)??'',hidden:false,addEventListener:(_type,listener)=>listeners.set(selector,listener)});
  vi.stubGlobal('document',{querySelector:(selector:string)=>elements.get(selector)});
  const api={
    getStatus:vi.fn(async()=>({state:'normal',revision:1,knownTokens:0,unknown:0,recoveryAllowed:false})),
    preflight:vi.fn(),confirm:vi.fn(),revokeConsent:vi.fn(),
    readProviderSettings:vi.fn(async()=>({generation:4,revision:2,selected:'api',state:'ready',active:{selected:'api',api:null},draft:{selected:'api',api:{profileId:'p',name:'Provider',baseUrl:'https://api.example.test/v1',protocol:'responses',model:'model',reasoningEffort:'medium',maxOutputTokens:2048,dailyCallLimit:24,keyConfigured:true}},keyConfigured:false,account:{label:'person@example.invalid',observedAt:1000,expiresAt:301000},recipient:'Codex Progress HUD observer'})),
    saveProviderSettings:vi.fn(async()=>api.readProviderSettings()),checkProvider:vi.fn(async()=>({ok:true,stage:'network'})),trialProvider:vi.fn(),activateProvider:vi.fn(),cancelProviderAction:vi.fn(),replaceSubscriptionAccount:vi.fn(async()=>({outcome:'cancelled'})),
  };
  vi.stubGlobal('window',{codexProgressHudSettings:api});
  await import('../../src/ui/settings-renderer.js');
  await vi.waitFor(()=>expect(elements.get('#provider-account')?.textContent).toContain('person@example.invalid'));
  expect(elements.get('#api-key-state')?.textContent).toContain('已配置');
  const model=elements.get('#api-model')!; model.value='changed'; listeners.get('#api-model')!({target:model});
  expect(elements.get('#provider-dirty')?.textContent).toContain('未保存');
  const key=elements.get('#api-key')!; key.value='one-shot-secret'; listeners.get('#provider-save')!();
  await vi.waitFor(()=>expect(api.saveProviderSettings).toHaveBeenCalled());
  expect(key.value).toBe('');
  await vi.waitFor(()=>expect(elements.get('#provider-save')?.disabled).toBe(false));
  listeners.get('#subscription-login')!();
  await vi.waitFor(()=>expect(elements.get('#message')?.textContent).toContain('已取消'));
});

it('renders unsupported protocol as a fixed validation message',async()=>{
  const listeners=new Map<string,(event?:unknown)=>void>();
  const elements=new Map<string,{textContent:string;disabled:boolean;value:string;hidden:boolean;addEventListener:(type:string,listener:(event?:unknown)=>void)=>void}>();
  for(const selector of ['#state','#known-tokens','#unknown-count','#message','#check','#recover','#revoke','#provider-source','#api-profile-id','#api-name','#api-base-url','#api-model','#api-protocol','#api-key','#api-key-state','#provider-dirty','#provider-account','#provider-account-time','#provider-recipient','#provider-save','#provider-check','#provider-trial','#provider-activate','#subscription-login','#subscription-device-login','#subscription-logout','#provider-cancel'])
    elements.set(selector,{textContent:'',disabled:false,value:'',hidden:false,addEventListener:(_type,listener)=>listeners.set(selector,listener)});
  vi.stubGlobal('document',{querySelector:(selector:string)=>elements.get(selector)});
  const provider={generation:1,revision:1,selected:'api',state:'inactive',active:{selected:'api',api:null},draft:{selected:'api',api:{profileId:'p',name:'Provider',baseUrl:'https://api.example.test/v1',protocol:'chat',model:'model',maxOutputTokens:2048,dailyCallLimit:24}},keyConfigured:false};
  vi.stubGlobal('window',{codexProgressHudSettings:{getStatus:async()=>({state:'normal',revision:1,knownTokens:0,unknown:0,recoveryAllowed:false}),readProviderSettings:async()=>provider}});
  await import('../../src/ui/settings-renderer.js');
  await vi.waitFor(()=>expect(elements.get('#message')?.textContent).toContain('协议'));
});
