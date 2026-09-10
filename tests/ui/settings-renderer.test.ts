import {afterEach,expect,it,vi} from 'vitest';

afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
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
