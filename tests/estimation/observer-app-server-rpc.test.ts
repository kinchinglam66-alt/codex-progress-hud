import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createObserverAppServerRpc, type AppServerNotification} from '../../src/estimation/observer-app-server-rpc.js';

type JsonRecord = Record<string, unknown>;

function fixture(options: {timeoutMs?: number; maxFrameBytes?: number; onRemoteError?:(error:{code:number;message:string})=>void} = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: JsonRecord[] = [];
  const waiters: Array<(frame: JsonRecord) => void> = [];
  let pending = '';
  input.on('data', (chunk: Buffer | string) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      const frame = JSON.parse(line) as JsonRecord;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else sent.push(frame);
      newline = pending.indexOf('\n');
    }
  });
  const nextSent = async (): Promise<JsonRecord> => {
    const frame = sent.shift();
    if (frame) return frame;
    return new Promise(resolve => waiters.push(resolve));
  };
  const rpc = createObserverAppServerRpc({input, output, ...options});
  return {input, output, rpc, nextSent};
}

it('optional local error observer cannot replace transport failure or leak raw messages into exceptions',async()=>{
 const observed:any[]=[];
 const f=fixture({onRemoteError:error=>{observed.push(error);throw Error('callback failure');}});
 const request=f.rpc.call('thread/fork',{});const frame=await f.nextSent();
 f.output.write(line({id:frame.id,error:{code:-32602,message:'synthetic turn not found'}}));
 await expect(request).rejects.toThrow('APP_SERVER_RPC_ERROR');
 expect(observed).toEqual([{code:-32602,message:'synthetic turn not found'}]);f.rpc.close();
});

function line(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());
it('notifies closure once, isolates listener failures and supports unsubscribe and late registration',()=>{
 const f=fixture(),removed=vi.fn(),survivor=vi.fn(),late=vi.fn();
 f.rpc.subscribeClosed(removed)();f.rpc.subscribeClosed(()=>{throw Error('private detail');});f.rpc.subscribeClosed(survivor);
 f.rpc.close('private failure detail');f.rpc.close();f.rpc.subscribeClosed(late);
 expect(removed).not.toHaveBeenCalled();expect(survivor).toHaveBeenCalledExactlyOnceWith();expect(late).toHaveBeenCalledExactlyOnceWith();
 expect(f.output.listenerCount('data')).toBe(0);
});
it.each(['end','error','close'] as const)('notifies transport closure on output %s even without pending RPCs',event=>{
 const f=fixture(),notice=vi.fn();f.rpc.subscribeClosed(notice);
 if(event==='error')f.output.emit(event,Error('synthetic disconnect'));else f.output.emit(event);
 expect(f.rpc.closed()).toBe(true);expect(notice).toHaveBeenCalledExactlyOnceWith();
});

describe('observer app-server JSONL RPC transport', () => {
  it('writes numeric requests and correlates out-of-order responses', async () => {
    const {rpc, output, nextSent} = fixture();
    const first = rpc.call('first', {value: 1});
    const second = rpc.call('second', {value: 2});
    const request1 = await nextSent();
    const request2 = await nextSent();

    expect(request1).toMatchObject({jsonrpc: '2.0', id: 1, method: 'first', params: {value: 1}});
    expect(request2).toMatchObject({jsonrpc: '2.0', id: 2, method: 'second', params: {value: 2}});
    output.write(line({jsonrpc: '2.0', id: request2.id, result: 'two'}));
    output.write(line({jsonrpc: '2.0', id: request1.id, result: 'one'}));
    await expect(second).resolves.toBe('two');
    await expect(first).resolves.toBe('one');
    rpc.close();
  });

  it('reassembles UTF-8 split across chunks and emits notifications immediately', async () => {
    const {rpc, output} = fixture();
    const notifications: AppServerNotification[] = [];
    rpc.subscribe(notification => notifications.push(notification));
    const bytes = line({jsonrpc: '2.0', method: 'progress', params: {text: 'café 😀'}});
    for (let index = 0; index < bytes.length; index += 1) output.write(bytes.subarray(index, index + 1));
    await flush();
    expect(notifications).toEqual([{method: 'progress', params: {text: 'café 😀'}}]);
    rpc.close();
  });

  it('does not accumulate or lose a long notification stream', async () => {
    const {rpc, output} = fixture();
    let count = 0;
    rpc.subscribe(() => { count += 1; });
    for (let index = 0; index < 300; index += 1) {
      output.write(line({jsonrpc: '2.0', method: 'progress', params: {index}}));
    }
    await flush();
    expect(count).toBe(300);
    rpc.close();
  });

  it('applies the frame limit per frame, not to a chunk containing many valid frames', async () => {
    const {rpc, output} = fixture({maxFrameBytes: 100});
    let count = 0;
    rpc.subscribe(() => { count += 1; });
    const validFrames = Array.from({length: 20}, (_, index) => JSON.stringify({jsonrpc: '2.0', method: 'p', params: {index}})).join('\n');
    output.write(Buffer.from(`${validFrames}\n${JSON.stringify({jsonrpc: '2.0', method: 'p', params: {text: 'x'.repeat(200)}})}\n`, 'utf8'));
    await flush();
    expect(count).toBe(20);
    expect(rpc.closed()).toBe(true);
  });

  it('ignores unknown and duplicate response IDs safely', async () => {
    const {rpc, output} = fixture();
    const pending = rpc.call('known', {});
    output.write(line({jsonrpc: '2.0', id: 999, result: 'unknown'}));
    output.write(line({jsonrpc: '2.0', id: 1, result: 'known'}));
    output.write(line({jsonrpc: '2.0', id: 1, result: 'duplicate'}));
    await expect(pending).resolves.toBe('known');
    expect(rpc.closed()).toBe(false);
    rpc.close();
  });

  it('sanitizes RPC error data without closing a healthy transport', async () => {
    const {rpc, output} = fixture();
    const pending = rpc.call('fails', {});
    output.write(line({jsonrpc: '2.0', id: 1, error: {code: -32001, message: 'private message', data: {secret: 'do not leak'}}}));
    const rejection = await pending.catch(error => error);
    if (!(rejection instanceof Error)) throw new Error('expected an Error rejection');
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).not.toContain('private');
    expect(rejection.message).not.toContain('secret');
    expect(rpc.closed()).toBe(false);
    rpc.close();
  });

  it('closes and rejects pending calls on malformed responses, EOF, and oversized frames', async () => {
    const malformed = fixture();
    const malformedPending = malformed.rpc.call('malformed', {});
    malformed.output.write(line({jsonrpc: '2.0', id: 1, result: 1, error: {code: 1, message: 'both'}}));
    await expect(malformedPending).rejects.toThrow('APP_SERVER_RPC_INVALID_RESPONSE');
    expect(malformed.rpc.closed()).toBe(true);

    const eof = fixture();
    const eofPending = eof.rpc.call('eof', {});
    eof.output.end();
    await expect(eofPending).rejects.toThrow('APP_SERVER_RPC_EOF');
    expect(eof.rpc.closed()).toBe(true);

    const oversized = fixture({maxFrameBytes: 64});
    const oversizedPending = oversized.rpc.call('oversized', {});
    oversized.output.write(Buffer.from(`${'x'.repeat(65)}\n`, 'utf8'));
    await expect(oversizedPending).rejects.toThrow('APP_SERVER_RPC_FRAME_TOO_LARGE');
    expect(oversized.rpc.closed()).toBe(true);
  });

  it('closes the transport on timeout so it cannot be reused', async () => {
    vi.useFakeTimers();
    const {rpc} = fixture({timeoutMs: 25});
    const pending = rpc.call('slow', {});
    const rejection = expect(pending).rejects.toThrow('APP_SERVER_RPC_TIMEOUT');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(rpc.closed()).toBe(true);
    await expect(rpc.call('after-timeout', {})).rejects.toThrow('APP_SERVER_RPC_CLOSED');
  });

  it('rejects server-initiated requests with JSON-RPC method-not-found', async () => {
    const {rpc, output, nextSent} = fixture();
    output.write(line({jsonrpc: '2.0', id: 44, method: 'tools/call', params: {name: 'secret'}}));
    await expect(nextSent()).resolves.toMatchObject({jsonrpc: '2.0', id: 44, error: {code: -32601, message: 'Method not found'}});
    rpc.close();
  });

  it('fails closed when a subscriber throws', async () => {
    const {rpc, output} = fixture();
    const pending = rpc.call('waiting', {});
    rpc.subscribe(() => { throw new Error('subscriber private detail'); });
    output.write(line({jsonrpc: '2.0', method: 'progress', params: {}}));
    await expect(pending).rejects.toThrow('APP_SERVER_RPC_SUBSCRIBER_FAILED');
    expect(rpc.closed()).toBe(true);
  });

  it('rejects pending calls on input errors without leaking the raw error', async () => {
    const {rpc, input} = fixture();
    const pending = rpc.call('write-error', {});
    input.destroy(new Error('raw write secret'));
    const rejection = await pending.catch(error => error);
    if (!(rejection instanceof Error)) throw new Error('expected an Error rejection');
    expect(rejection.message).not.toContain('raw write secret');
    expect(rpc.closed()).toBe(true);
  });

  it('bounds host RPC requests at 32 pending calls and cleans up idempotently', async () => {
    const {rpc} = fixture();
    const pending = Array.from({length: 32}, (_, index) => rpc.call(`pending-${index}`, {}));
    await expect(rpc.call('overflow', {})).rejects.toThrow('APP_SERVER_RPC_PENDING_LIMIT');
    rpc.close('APP_SERVER_RPC_CLOSED');
    rpc.close('ignored');
    expect(rpc.closed()).toBe(true);
    await expect(Promise.all(pending)).rejects.toThrow('APP_SERVER_RPC_CLOSED');
  });

it('validates positive safe timeout and frame bounds', () => {
    expect(() => fixture({timeoutMs: 0})).toThrow();
    expect(() => fixture({timeoutMs: 1.5})).toThrow();
    expect(() => fixture({timeoutMs: Number.MAX_SAFE_INTEGER + 1})).toThrow();
    expect(() => fixture({maxFrameBytes: 0})).toThrow();
    expect(() => fixture({maxFrameBytes: 1.5})).toThrow();
    expect(() => fixture({maxFrameBytes: Number.MAX_SAFE_INTEGER + 1})).toThrow();
});

it('closes on an oversized outbound request frame', async()=>{
 const {rpc}=fixture({maxFrameBytes:64});
 await expect(rpc.call('oversized',{text:'x'.repeat(256)})).rejects.toThrow('APP_SERVER_RPC_FRAME_TOO_LARGE');
 expect(rpc.closed()).toBe(true);
});

it('closes when backpressure leaves too many outbound frames queued', async()=>{
 const input=new PassThrough({highWaterMark:1});
 const output=new PassThrough();
 const rpc=createObserverAppServerRpc({input,output,maxQueuedFrames:3,maxQueuedBytes:1024});
 for(let index=0;index<10;index++)rpc.notify('progress',{index});
 await flush();
 expect(rpc.closed()).toBe(true);
});
});
