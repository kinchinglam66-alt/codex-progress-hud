import {createOwnedLoginProcessRunner,type Invocation} from './owned-process.js';
type LoginProcessOutcome='process_exited'|'cancelled'|'failed'|'busy';
/** Host-private first-use action. Prepare must verify assets/home and build only
 * the subscription login command. Exit zero is not identity or consent proof.
 * Preparation must honor its signal and have bounded cleanup of its own. */
export function createObserverLoginOwner(prepare:(signal:AbortSignal)=>Invocation|Promise<Invocation>) {
  const runner=createOwnedLoginProcessRunner();
  let disabled=false;
  let pending:Promise<LoginProcessOutcome>|undefined;
  let preparation:AbortController|undefined;
  let closing:Promise<void>|undefined;
  const disable=()=>{disabled=true;preparation?.abort();runner.disable();};
  return {
    login(signal:AbortSignal):Promise<LoginProcessOutcome> {
      if(disabled || signal.aborted || closing) return Promise.resolve('cancelled');
      if(pending || runner.status().active) return Promise.resolve('busy');
      if(runner.status().poisoned) return Promise.resolve('failed');
      preparation=new AbortController();
      const combined=AbortSignal.any([signal,preparation.signal]);
      pending=Promise.resolve().then(async():Promise<LoginProcessOutcome>=>{
        if(combined.aborted || disabled) return 'cancelled';
        try {
          const invocation=await prepare(combined);
          if(combined.aborted || disabled) return 'cancelled';
          if(invocation.input!=='') return 'failed';
          // Streaming sink suppresses stdout and stderr retention in the runner.
          const result=await runner.run({...invocation,args:[...invocation.args],env:{...invocation.env},onStdout:()=>true},combined);
          if(combined.aborted || disabled) return 'cancelled';
          return result.closed && result.reason==='exited' && result.exitCode===0?'process_exited':'failed';
        } catch {return combined.aborted || disabled?'cancelled':'failed';}
      }).finally(()=>{pending=undefined;preparation=undefined;});
      return pending;
    },
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
