import {expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createObserverProviderHost} from '../../src/desktop/observer-provider-host.js';
it.each([true,false])('replaces an active subscription only with host-enabled account following (%s)',async(enabled)=>{
 const root=await mkdtemp(join(tmpdir(),'hud-follow-host-'));const events:string[]=[];let next=0;
 const host=await createObserverProviderHost({dataDirectory:root,consentProtection:{protect:v=>v,unprotect:v=>v},autoStartSubscription:true,followMainAccount:enabled,
  openSubscription:async(_signal,consent)=>{const id=++next;events.push(`open:${id}`);if(id===2)expect(consent?.kind).toBe('inline');return {workers:[],inspect:async()=>({label:'synthetic',fingerprint:String(id)}),close:async()=>{events.push(`close:${id}`);}};}});
 try{
  await host.start(new AbortController().signal);const generation=host.status().generation;
  expect(await host.followSubscriptionAccount(new AbortController().signal)).toBe(enabled);
  expect(events).toEqual(enabled?['open:1','close:1','open:2']:['open:1']);
  if(enabled)expect(host.status().generation).toBeGreaterThan(generation);
  host.disable();expect(await host.followSubscriptionAccount(new AbortController().signal)).toBe(false);
 }finally{await host.close();await rm(root,{recursive:true,force:true});}
});
