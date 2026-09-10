import {createOwnedLoginProcessRunner,type Invocation} from './owned-process.js';
export type LoginProcessOutcome='process_exited'|'cancelled'|'failed'|'busy';
export type ObserverLoginAction='login'|'device-auth'|'logout';
export interface ObserverDeviceAuthEvent {kind:'device-auth';url:string;code:string}
export interface ObserverLoginOwner {
  login(signal:AbortSignal):Promise<LoginProcessOutcome>;
  deviceAuth(signal:AbortSignal,onDeviceAuth?:(event:ObserverDeviceAuthEvent)=>void):Promise<LoginProcessOutcome>;
  deviceLogin(signal:AbortSignal,onDeviceAuth?:(event:ObserverDeviceAuthEvent)=>void):Promise<LoginProcessOutcome>;
  logout(signal:AbortSignal):Promise<LoginProcessOutcome>;
  disable():void;
  close():Promise<void>;
}

interface Options {onDeviceAuth?:(event:ObserverDeviceAuthEvent)=>void}
const ansi = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
/** Host-private first-use action. Prepare must verify assets/home and build only
 * the subscription login command. Exit zero is not identity or consent proof.
 * Preparation must honor its signal and have bounded cleanup of its own. */
export function createObserverLoginOwner(
  prepare:(signal:AbortSignal,action?:ObserverLoginAction)=>Invocation|Promise<Invocation>,
  options:Options = {},
):ObserverLoginOwner {
  const runner=createOwnedLoginProcessRunner();
  let disabled=false;
  let pending:Promise<LoginProcessOutcome>|undefined;
  let preparation:AbortController|undefined;
  let closing:Promise<void>|undefined;
  const disable=()=>{disabled=true;preparation?.abort();runner.disable();};
  const run=(signal:AbortSignal,action:ObserverLoginAction,onDeviceAuth?:((event:ObserverDeviceAuthEvent)=>void)):Promise<LoginProcessOutcome> => {
      if(disabled || signal.aborted || closing) return Promise.resolve('cancelled');
      if(pending || runner.status().active) return Promise.resolve('busy');
      if(runner.status().poisoned) return Promise.resolve('failed');
      preparation=new AbortController();
      const combined=AbortSignal.any([signal,preparation.signal]);
      pending=Promise.resolve().then(async():Promise<LoginProcessOutcome>=>{
        if(combined.aborted || disabled) return 'cancelled';
        try {
          const invocation=await prepare(combined,action);
          if(combined.aborted || disabled) return 'cancelled';
          if(invocation.input!=='') return 'failed';
          let output='';
          let emitted=false;
          const emitDeviceEvent=(chunk:Uint8Array):void=>{
            if(action!=='device-auth' || emitted) return;
            output=(output+Buffer.from(chunk).toString('utf8')).replace(ansi,'').slice(-8192);
            const urlMatch=output.match(/https:\/\/auth\.openai\.com\/codex\/device(?![A-Za-z0-9/_-])/u);
            const codeMatch=output.match(/\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8}){1,2}\b/u);
            if(!urlMatch || !codeMatch) return;
            emitted=true;
            const event={kind:'device-auth' as const,url:urlMatch[0],code:codeMatch[0]};
            try {onDeviceAuth?.(event);options.onDeviceAuth?.(event);} catch {/* Presentation is non-authoritative. */}
          };
          // The bounded callback consumes stdout without retaining raw auth data.
          const result=await runner.run({...invocation,args:[...invocation.args],env:{...invocation.env},
            onStdout:chunk=>{emitDeviceEvent(chunk);return true;},
            onStderr:chunk=>{emitDeviceEvent(chunk);return true;}},combined);
          if(combined.aborted || disabled) return 'cancelled';
          return result.closed && result.reason==='exited' && result.exitCode===0?'process_exited':'failed';
        } catch {return combined.aborted || disabled?'cancelled':'failed';}
      }).finally(()=>{pending=undefined;preparation=undefined;});
      return pending;
  };
  return {
    login(signal:AbortSignal):Promise<LoginProcessOutcome> {return run(signal,'login');},
    deviceAuth(signal:AbortSignal,onDeviceAuth?):Promise<LoginProcessOutcome> {return run(signal,'device-auth',onDeviceAuth);},
    deviceLogin(signal:AbortSignal,onDeviceAuth?):Promise<LoginProcessOutcome> {return run(signal,'device-auth',onDeviceAuth);},
    logout(signal:AbortSignal):Promise<LoginProcessOutcome> {return run(signal,'logout');},
    disable,
    close():Promise<void> {
      if(closing) return closing;
      disable();
      const operation=pending;
      closing=(async()=>{
        await operation;
        const state=runner.status();
        if(state.active || state.poisoned) throw Error('OBSERVER_LOGIN_CLOSE_UNCONFIRMED');
      })();
      return closing;
    },
  };
}
