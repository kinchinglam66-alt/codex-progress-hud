import {expect,it} from 'vitest';
import {createObserverFirstUse} from '../../src/desktop/observer-first-use.js';
import {createObserverConsentGate} from '../../src/estimation/observer-consent.js';
import {createObserverLoginOwner} from '../../src/estimation/observer-login-owner.js';
const proof={accountLabel:'synthetic@example.invalid',evidence:{accountFingerprint:'a'.repeat(64),routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64),observedAt:0,expiresAt:300000}};
it('detects explicit logged-out state before offering login and rechecks afterward',async()=>{
  const events:string[]=[];
  const gate=createObserverConsentGate({now:()=>0,onInvalidate:()=>{}});
  const login=createObserverLoginOwner(()=>{events.push('login');return {executable:process.execPath,cwd:process.cwd(),args:['-e','process.exit(0)'],env:process.env,input:''};});
  let reads=0;
  const flow=createObserverFirstUse({gate,login,attest:async()=>{events.push('attest');if(reads++===0)throw Error('OBSERVER_LOGIN_REQUIRED');return proof;},
    dialog:{showMessageBox:async()=>{events.push('dialog');return {response:0};}}});
  expect(await flow.start('detect',new AbortController().signal)).toBe('authorized');
  expect(events).toEqual(['attest','dialog','login','attest','dialog']);
  await flow.close();
});
it('does not offer login for transport failure during account detection',async()=>{
  const gate=createObserverConsentGate({now:()=>0,onInvalidate:()=>{}});
  let prompts=0,launches=0;
  const login=createObserverLoginOwner(()=>{launches++;throw Error('unexpected');});
  const flow=createObserverFirstUse({gate,login,attest:async()=>{throw Error('PRIVATE_NETWORK_ERROR');},dialog:{showMessageBox:async()=>{prompts++;return {response:0};}}});
  expect(await flow.start('detect',new AbortController().signal)).toBe('failed');
  expect(prompts).toBe(0);expect(launches).toBe(0);expect(gate.authorized()).toBe(false);
  await flow.close();
});
it('uses one successful account observation and only requests data consent',async()=>{
  const gate=createObserverConsentGate({now:()=>0,onInvalidate:()=>{}});
  let reads=0,launches=0;
  const login=createObserverLoginOwner(()=>{launches++;throw Error('unexpected');});
  const flow=createObserverFirstUse({gate,login,attest:async()=>{reads++;return proof;},dialog:{showMessageBox:async()=>({response:0})}});
  expect(await flow.start('detect',new AbortController().signal)).toBe('authorized');
  expect(reads).toBe(1);expect(launches).toBe(0);
  await flow.close();
});
function setup(responses:number[], failAttestation=false) {
  const events:string[]=[];
  const gate=createObserverConsentGate({now:()=>0,onInvalidate:()=>{}});
  const login=createObserverLoginOwner(()=>{events.push('login');return {executable:process.execPath,cwd:process.cwd(),args:['-e','process.exit(0)'],env:process.env,input:''};});
  const flow=createObserverFirstUse({gate,login,attest:async()=>{events.push('attest');if(failAttestation)throw Error('PRIVATE');return proof;},dialog:{showMessageBox:async options=>{
    expect(options.defaultId).toBe(1);expect(options.cancelId).toBe(1);events.push('dialog');return {response:responses.shift()??1};
  }}});
  return {events,gate,flow};
}
it('requires login, attestation and separate data consent in that order',async()=>{
  const {flow,events,gate}=setup([0,0]);
  expect(await flow.start(true,new AbortController().signal)).toBe('authorized');
  expect(events).toEqual(['dialog','login','attest','dialog']);
  expect(gate.authorized()).toBe(true);
  await flow.close();expect(gate.authorized()).toBe(false);
});
it('does not launch or attest when first-use login is declined',async()=>{
  const {flow,events,gate}=setup([1]);
  expect(await flow.start(true,new AbortController().signal)).toBe('declined');
  expect(events).toEqual(['dialog']);expect(gate.authorized()).toBe(false);
  await flow.close();
});
it('does not treat login exit as consent when account attestation fails',async()=>{
  const {flow,events,gate}=setup([0,0],true);
  expect(await flow.start(true,new AbortController().signal)).toBe('failed');
  expect(events).toEqual(['dialog','login','attest']);expect(gate.authorized()).toBe(false);
  await flow.close();
});
it('cancels a pending native consent prompt and ignores its later approval',async()=>{
  let shown!:()=>void,reply!:(value:{response:number})=>void;
  const visible=new Promise<void>(resolve=>{shown=resolve;});
  const gate=createObserverConsentGate({now:()=>0,onInvalidate:()=>{}});
  const login=createObserverLoginOwner(()=>{throw Error('must not login');});
  const flow=createObserverFirstUse({gate,login,attest:async()=>proof,dialog:{showMessageBox:()=>{shown();return new Promise(resolve=>{reply=resolve;});}}});
  const operation=flow.start(false,new AbortController().signal);
  await visible;
  expect(await flow.start(false,new AbortController().signal)).toBe('busy');
  flow.disable();
  expect(await operation).toBe('cancelled');
  await flow.close();
  reply({response:0});await Promise.resolve();await Promise.resolve();
  expect(gate.authorized()).toBe(false);
});

it('does not let approval from a cancelled attempt authorize a newer attempt',async()=>{
  const replies:Array<(value:{response:number})=>void>=[];
  const arrivals:Array<()=>void>=[];
  const gate=createObserverConsentGate({now:()=>0,onInvalidate:()=>{}});
  const login=createObserverLoginOwner(()=>{throw Error('must not login');});
  const flow=createObserverFirstUse({gate,login,attest:async()=>proof,dialog:{showMessageBox:()=>new Promise(resolve=>{replies.push(resolve);arrivals.shift()?.();})}});
  const shown=()=>new Promise<void>(resolve=>arrivals.push(resolve));
  const firstShown=shown(),controller=new AbortController();
  const first=flow.start(false,controller.signal);
  await firstShown;controller.abort();expect(await first).toBe('cancelled');
  const secondShown=shown(),second=flow.start(false,new AbortController().signal);
  await secondShown;
  replies[0]!({response:0});await Promise.resolve();await Promise.resolve();
  expect(gate.authorized()).toBe(false);
  replies[1]!({response:0});expect(await second).toBe('authorized');
  await flow.close();
});
