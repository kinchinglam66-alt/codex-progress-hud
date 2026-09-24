import {EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createHomeCheckTransport} from '../../src/estimation/home-check-transport.js';

const path='C:\\synthetic\\observer-auth';
const invocation={executable:process.execPath,cwd:resolve('synthetic'),args:[],env:{}};
function fixture(autoClose=true) {
  const children:Array<EventEmitter & {stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;kill:()=>boolean;requests:string[]}> = [];
  const transport=createHomeCheckTransport(invocation,path,{spawn:()=>{
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),requests:[] as string[],kill:()=>{
      if(autoClose)queueMicrotask(()=>child.emit('close',0)); return true;
    }});
    child.stdin.on('data',chunk=>child.requests.push(String(chunk)));
    children.push(child); return child as unknown as ChildProcessWithoutNullStreams;
  }});
  const reply=(id:number, index=children.length-1)=>children[index]!.stdout.write(JSON.stringify({v:1,id,ok:true,path})+'\n');
  return {transport,children,reply};
}
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>vi.useRealTimers());

it('rejects a pre-aborted request without starting a helper',async()=>{
  const {transport,children}=fixture(); const controller=new AbortController(); controller.abort();
  await expect(transport.check(true,controller.signal)).rejects.toThrow('HOME_CHECK_UNAVAILABLE');
  expect(children).toHaveLength(0); await transport.close();
});

it('reuses an idle child but requires a fresh response for each check',async()=>{
  const {transport,children,reply}=fixture(); const signal=new AbortController().signal;
  const first=transport.check(false,signal); reply(1); await expect(first).resolves.toBe(path);
  expect(transport.status()).toEqual({checking:false,resident:true,closing:false,poisoned:false});
  const second=transport.check(true,signal);
  expect(transport.status().checking).toBe(true);
  expect(children).toHaveLength(1);
  expect(children[0]!.requests.map(value=>JSON.parse(value))).toEqual([{v:1,id:1,op:'prepare'},{v:1,id:2,op:'verify'}]);
  reply(2); await expect(second).resolves.toBe(path); await transport.close();
  expect(transport.status().resident).toBe(false);
});

it.each([
  ['wrong id',JSON.stringify({v:1,id:9,ok:true,path})+'\n'],
  ['extra field',JSON.stringify({v:1,id:1,ok:true,path,extra:true})+'\n'],
  ['wrong path',JSON.stringify({v:1,id:1,ok:true,path:'C:/elsewhere'})+'\n'],
  ['failure',JSON.stringify({v:1,id:1,ok:false,code:'OBSERVER_HOME_UNAVAILABLE'})+'\n'],
  ['malformed','{bad}\n'],
  ['oversized','x'.repeat(4097)],
  ['invalid UTF8',Buffer.from([0xff,10])],
])('rejects %s and closes the helper',async(_label,frame)=>{
  const {transport,children}=fixture(); const pending=transport.check(true,new AbortController().signal);
  const rejected=expect(pending).rejects.toThrow('HOME_CHECK_FAILED');
  children[0]!.stdout.write(frame); await rejected;
  expect(transport.status().resident).toBe(false); await transport.close();
});

it('assembles a bounded split response without accepting partial output',async()=>{
  const {transport,children}=fixture(); const pending=transport.check(true,new AbortController().signal);
  const data=JSON.stringify({v:1,id:1,ok:true,path})+'\n';
  children[0]!.stdout.write(data.slice(0,8)); expect(transport.status().checking).toBe(true);
  children[0]!.stdout.write(data.slice(8)); await expect(pending).resolves.toBe(path); await transport.close();
});

it('rejects a simultaneous request without disrupting its owner',async()=>{
  const {transport,reply}=fixture(); const signal=new AbortController().signal;
  const owner=transport.check(true,signal);
  await expect(transport.check(true,signal)).rejects.toThrow('HOME_CHECK_BUSY');
  reply(1); await owner; await transport.close();
});

it('cancellation waits for close and never accepts a late success',async()=>{
  const {transport,children,reply}=fixture(false); const controller=new AbortController();
  const pending=transport.check(true,controller.signal); const rejected=expect(pending).rejects.toThrow('HOME_CHECK_FAILED');
  controller.abort(); reply(1);
  expect(transport.status()).toMatchObject({checking:true,resident:true,closing:true});
  children[0]!.emit('close',0); await rejected; await transport.close();
});

it('times out a silent request and confirms exit',async()=>{
  const {transport}=fixture(); const rejected=expect(transport.check(true,new AbortController().signal)).rejects.toThrow('HOME_CHECK_FAILED');
  await vi.advanceTimersByTimeAsync(10000); await rejected; await transport.close();
});

it('poisons on cleanup timeout and forbids replacement even after a late close',async()=>{
  const {transport,children}=fixture(false); const controller=new AbortController();
  const pending=expect(transport.check(true,controller.signal)).rejects.toThrow('HOME_CHECK_FAILED'); controller.abort();
  await vi.advanceTimersByTimeAsync(5000); await pending;
  expect(transport.status()).toMatchObject({resident:true,poisoned:true});
  await expect(transport.check(true,new AbortController().signal)).rejects.toThrow();
  children[0]!.emit('close',0);
  await expect(transport.close()).rejects.toThrow('HOME_CHECK_CLOSE_UNCONFIRMED');
  expect(children).toHaveLength(1);
});

it('retires after idle deadline and ignores old generation output',async()=>{
  const {transport,children,reply}=fixture(); const signal=new AbortController().signal;
  const first=transport.check(true,signal); reply(1); await first;
  await vi.advanceTimersByTimeAsync(30000); expect(transport.status().resident).toBe(false);
  const second=transport.check(true,signal); reply(1,0);
  expect(transport.status().checking).toBe(true); reply(2,1); await second; await transport.close();
});

it('stderr and unexpected exit reject active checks',async()=>{
  for(const type of ['stderr','exit']) {
    const {transport,children}=fixture(); const rejected=expect(transport.check(true,new AbortController().signal)).rejects.toThrow();
    if(type==='stderr')children[0]!.stderr.write('error'); else children[0]!.emit('close',1);
    await rejected; await transport.close();
  }
});

it('unsolicited idle output retires the helper and closed owners never restart',async()=>{
  const {transport,children,reply}=fixture(); const first=transport.check(true,new AbortController().signal);
  reply(1); await first; reply(1); await transport.retire(); await transport.close();
  await expect(transport.check(true,new AbortController().signal)).rejects.toThrow();
  expect(children).toHaveLength(1);
});
