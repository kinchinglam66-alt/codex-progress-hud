import {EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createNativeGuardTransport} from '../../src/estimation/native-guard-transport.js';
function fixture(autoClose=true,idleTimeoutMs?:number){
 const children:Array<EventEmitter & {stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;kill:()=>boolean}>=[];
 const transport=createNativeGuardTransport({executable:process.execPath,args:[],cwd:resolve('synthetic'),env:{}},{...(idleTimeoutMs===undefined?{}:{idleTimeoutMs}),spawn:()=>{
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{
   if(autoClose)queueMicrotask(()=>child.emit('close',0));return true;
  }});children.push(child);return child as unknown as ChildProcessWithoutNullStreams;
 }});
 const reply=(id:number,index=children.length-1)=>children[index]!.stdout.write(`{"v":1,"id":${id},"op":"verify_storage","result":"ok"}\n`);
 return {transport,children,reply};
}
const request={op:'verify_storage'} as const;
const signal=()=>new AbortController().signal;
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
it('reuses process but never a previous check result',async()=>{
 const {transport,children,reply}=fixture();
 const first=transport.check(request,signal());reply(1);await expect(first).resolves.toBe('ok');
 const second=transport.check(request,signal());expect(transport.status().checking).toBe(true);
 expect(children).toHaveLength(1);reply(2);await second;await transport.close();
});
it('busy request does not replace the active owner',async()=>{
 const {transport,reply}=fixture();const first=transport.check(request,signal());
 await expect(transport.check(request,signal())).rejects.toThrow('BUSY');reply(1);await first;await transport.close();
});
it('aborted request never launches',async()=>{
 const {transport,children}=fixture();const controller=new AbortController();controller.abort();
 await expect(transport.check(request,controller.signal)).rejects.toThrow();expect(children).toHaveLength(0);await transport.close();
});
it('cancellation rejects late success and waits for actual close',async()=>{
 const {transport,children,reply}=fixture(false);const controller=new AbortController();
 const pending=expect(transport.check(request,controller.signal)).rejects.toThrow();controller.abort();reply(1);
 expect(transport.status().closing).toBe(true);children[0]!.emit('close',0);await pending;await transport.close();
});
it('unconfirmed close permanently forbids replacement',async()=>{
 const {transport,children}=fixture(false);const controller=new AbortController();
 const pending=expect(transport.check(request,controller.signal)).rejects.toThrow();controller.abort();
 await vi.advanceTimersByTimeAsync(5000);await pending;children[0]!.emit('close',0);
 await expect(transport.check(request,signal())).rejects.toThrow();await expect(transport.close()).rejects.toThrow('CLOSE_UNCONFIRMED');
 expect(children).toHaveLength(1);
});
it('retires idle process and ignores old generation frames',async()=>{
 const {transport,children,reply}=fixture();const first=transport.check(request,signal());reply(1);await first;
 await vi.advanceTimersByTimeAsync(30000);const next=transport.check(request,signal());reply(1,0);
 expect(transport.status().checking).toBe(true);reply(2,1);await next;expect(children).toHaveLength(2);await transport.close();
});
it('can retain the verifier through ordinary task cadence but still checks anew and retires at its bound',async()=>{
 const {transport,children,reply}=fixture(true,1860000);
 const first=transport.check(request,signal());reply(1);await first;
 await vi.advanceTimersByTimeAsync(270000);
 expect(transport.status().resident).toBe(true);
 const next=transport.check(request,signal());expect(transport.status().checking).toBe(true);expect(children).toHaveLength(1);
 reply(2);await next;
 await vi.advanceTimersByTimeAsync(1859999);expect(transport.status().resident).toBe(true);
 await vi.advanceTimersByTimeAsync(1);expect(transport.status().resident).toBe(false);
 await transport.close();
});
it.each([0,-1,29999,1860001,Infinity,NaN,30000.5])('rejects unsafe verifier idle duration %s',value=>{
 expect(()=>fixture(true,value)).toThrow('NATIVE_GUARD_INVALID_IDLE_TIMEOUT');
});
it.each(['bad\n','x'.repeat(1025),Buffer.from([255,10]),'{"v":1,"id":2,"op":"verify_storage","result":"ok"}\n'])('rejects invalid response %s',async frame=>{
 const {transport,children}=fixture();const pending=expect(transport.check(request,signal())).rejects.toThrow();
 children[0]!.stdout.write(frame);await pending;expect(transport.status().resident).toBe(false);await transport.close();
});
it('six second request deadline closes silent helper',async()=>{
 const {transport}=fixture();const pending=expect(transport.check(request,signal())).rejects.toThrow();
 await vi.advanceTimersByTimeAsync(6000);await pending;await transport.close();
});
it('stderr fails active request',async()=>{
 const {transport,children}=fixture();const pending=expect(transport.check(request,signal())).rejects.toThrow();
 children[0]!.stderr.write('unexpected');await pending;await transport.close();
});
it('accepts a split frame only once it is complete',async()=>{
 const {transport,children}=fixture();const pending=transport.check(request,signal());
 children[0]!.stdout.write('{"v":1,"id":1,');expect(transport.status().checking).toBe(true);
 children[0]!.stdout.write('"op":"verify_storage","result":"ok"}\n');await expect(pending).resolves.toBe('ok');await transport.close();
});
it('rejects trailing or unsolicited frames and explicit close forbids restart',async()=>{
 const {transport,children}=fixture();const pending=expect(transport.check(request,signal())).rejects.toThrow();
 children[0]!.stdout.write('{"v":1,"id":1,"op":"verify_storage","result":"ok"}\n{}\n');
 await pending;await transport.close();await expect(transport.check(request,signal())).rejects.toThrow();expect(children).toHaveLength(1);
});
