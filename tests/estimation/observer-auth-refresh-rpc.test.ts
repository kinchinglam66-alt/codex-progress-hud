import {PassThrough} from 'node:stream';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {createObserverAppServerRpc} from '../../src/estimation/observer-app-server-rpc.js';

const method='account/chatgptAuthTokens/refresh';
function fixture(handler?: (params:any,signal:AbortSignal)=>Promise<any>) {
  const input=new PassThrough(),output=new PassThrough();
  const frames:any[]=[];let text='';
  input.on('data',chunk=>{text+=chunk.toString();let end;
    while((end=text.indexOf('\n'))>=0){frames.push(JSON.parse(text.slice(0,end)));text=text.slice(end+1);}});
  const rpc=createObserverAppServerRpc({input,output,...(handler?{onChatgptAuthTokensRefresh:handler}:{})});
  const send=(id:number,params:unknown={reason:'unauthorized',previousAccountId:'account-a'},name=method)=>
    output.write(JSON.stringify({id,method:name,params})+'\n');
  return {rpc,frames,send};
}
afterEach(()=>vi.useRealTimers());
describe('external account refresh RPC',()=>{
  it('returns a same-account refresh reply without exposing extra credential fields',async()=>{
    const f=fixture(async()=>({accessToken:'synthetic-token',chatgptAccountId:'account-a',refreshToken:'must-not-forward'}));
    f.send(81);await vi.waitFor(()=>expect(f.frames).toHaveLength(1));
    expect(f.frames[0]).toEqual({jsonrpc:'2.0',id:81,result:{accessToken:'synthetic-token',chatgptAccountId:'account-a'}});
    f.rpc.close();
  });
  it('rejects a new account token instead of retrying old work under the new account',async()=>{
    const f=fixture(async()=>({accessToken:'private-token',chatgptAccountId:'account-b'}));
    f.send(82);await vi.waitFor(()=>expect(f.frames).toHaveLength(1));
    expect(f.frames[0].error.code).toBe(-32000);
    expect(JSON.stringify(f.frames)).not.toContain('private-token');f.rpc.close();
  });
  it('sanitizes refresh errors and rejects unsupported requests without invoking the handler',async()=>{
    const f=fixture(async()=>{throw Error('private-secret');});
    f.send(83);await vi.waitFor(()=>expect(f.frames).toHaveLength(1));
    expect(f.frames[0].error.code).toBe(-32000);expect(JSON.stringify(f.frames)).not.toContain('private-secret');
    f.send(84,{},'item/commandExecution/requestApproval');
    await vi.waitFor(()=>expect(f.frames).toHaveLength(2));expect(f.frames[1].error.code).toBe(-32601);f.rpc.close();
  });
  it('aborts an outstanding refresh on close and discards the late credentials',async()=>{
    let signal:AbortSignal|undefined;let resolve!: (value:unknown)=>void;
    const f=fixture(async(_params,s)=>{signal=s;return new Promise(r=>{resolve=r;});});
    f.send(85);await vi.waitFor(()=>expect(signal).toBeDefined());f.rpc.close();
    expect(signal!.aborted).toBe(true);resolve({accessToken:'late-token',chatgptAccountId:'account-a'});
    await Promise.resolve();await Promise.resolve();expect(f.frames).toHaveLength(0);
  });
  it('bounds a stalled refresh and closes the transport',async()=>{
    vi.useFakeTimers();let signal:AbortSignal|undefined;
    const f=fixture(async(_params,s)=>{signal=s;return new Promise(()=>{});});f.send(86);
    await vi.advanceTimersByTimeAsync(10000);
    expect(signal?.aborted).toBe(true);expect(f.rpc.closed()).toBe(true);
  });
  it('supports server string request IDs and rejects malformed refresh parameters',async()=>{
    const f=fixture(async()=>({accessToken:'synthetic-token',chatgptAccountId:'account-a'}));
    f.send('refresh-1' as any);await vi.waitFor(()=>expect(f.frames).toHaveLength(1));
    expect(f.frames[0].id).toBe('refresh-1');expect(f.frames[0].result.chatgptAccountId).toBe('account-a');
    f.send(90,{reason:'unexpected'});await vi.waitFor(()=>expect(f.frames).toHaveLength(2));
    expect(f.frames[1].error.code).toBe(-32602);f.rpc.close();
  });
  it('closes on overlapping refresh work and rejects a handler that has not been enabled',async()=>{
    const disabled=fixture();disabled.send(91);
    expect(disabled.frames[0].error.code).toBe(-32601);disabled.rpc.close();
    const f=fixture(async()=>new Promise(()=>{}));f.send(92);f.send(93);
    expect(f.rpc.closed()).toBe(true);expect(f.frames).toHaveLength(0);
  });
});
