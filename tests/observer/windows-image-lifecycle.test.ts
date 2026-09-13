import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({children:[] as any[]}));
vi.mock('node:child_process',()=>({spawn:vi.fn(()=>{
 const child=new EventEmitter() as any;
 child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=vi.fn(()=>true);
 state.children.push(child);return child;
})}));
afterEach(()=>{for(const child of state.children.splice(0))child.emit('close',1);vi.useRealTimers();});
it.skipIf(process.platform!=='win32')('waits for helper closure after either pipe fails',async()=>{
 vi.resetModules();const {readWindowsImage}=await import('../../src/observer/windows-image-reader.js');
 for(const pipe of ['stdin','stdout']){
  let done=false;
  const result=readWindowsImage('C:/synthetic.png',{signal:new AbortController().signal,maxEncodedBytes:4096}).catch(error=>{done=true;return error.code;});
  const child=state.children.at(-1);child[pipe].emit('error',Error('synthetic pipe failure'));
  await Promise.resolve();await Promise.resolve();
  expect(done).toBe(false);expect(child.kill).toHaveBeenCalledOnce();
  child.emit('close',1);expect(await result).toBe('READ_FAILED');
 }
});
it.skipIf(process.platform!=='win32')('blocks replacements after unconfirmed cleanup until the original helper closes',async()=>{
 vi.useFakeTimers();vi.resetModules();const {readWindowsImage}=await import('../../src/observer/windows-image-reader.js');
 const controller=new AbortController();let done=false;
 const result=readWindowsImage('C:/synthetic.png',{signal:controller.signal,maxEncodedBytes:4096}).catch(error=>{done=true;return error.code;});
 const child=state.children.at(-1);controller.abort();
 await Promise.resolve();expect(done).toBe(false);
 await vi.advanceTimersByTimeAsync(2500);expect(await result).toBe('CANCELLED');
 const count=state.children.length;
 const denied=readWindowsImage('C:/synthetic.png',{signal:new AbortController().signal,maxEncodedBytes:4096}).catch(error=>error.code);
 expect(state.children).toHaveLength(count);
 expect(await denied).toBe('READ_FAILED');
 child.emit('close',1);
 const next=readWindowsImage('C:/synthetic.png',{signal:new AbortController().signal,maxEncodedBytes:4096});
 const replacement=state.children.at(-1);replacement.stdout.write('missing\n');replacement.emit('close',0);
 expect(await next).toBeNull();
});
