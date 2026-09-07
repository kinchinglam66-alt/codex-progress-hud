import {requestObserverConsent,type ObserverConsentDialog} from './observer-consent-dialog.js';
import type {createObserverConsentGate,ObserverAttestation} from '../estimation/observer-consent.js';
import type {createObserverLoginOwner} from '../estimation/observer-login-owner.js';
interface Options {
  dialog:ObserverConsentDialog;
  gate:ReturnType<typeof createObserverConsentGate>;
  login:ReturnType<typeof createObserverLoginOwner>;
  attest:(signal:AbortSignal)=>Promise<{accountLabel:string;evidence:ObserverAttestation}>;
}
export function createObserverFirstUse(options:Options) {
  type Outcome='authorized'|'declined'|'cancelled'|'failed'|'busy';
  let disabled=false, pending:Promise<Outcome>|undefined, closing:Promise<void>|undefined;
  let controller:AbortController|undefined;
  const {gate,dialog,login,attest}=options;
  const disable=()=>{disabled=true;controller?.abort();gate.revoke();login.disable();};
  // Native prompts cannot be forcibly resolved through this dialog interface.
  // Stop awaiting on cancellation; late consent tokens have already been revoked.
  function prompt<T>(operation:Promise<T>,signal:AbortSignal):Promise<T> {
    return new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(Error('SETUP_CANCELLED'));};
      signal.addEventListener('abort',abort,{once:true});
      operation.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
      if(signal.aborted) abort();
    });
  }
  return {
    start(loginRequired:boolean|'detect',signal:AbortSignal):Promise<Outcome> {
      if(disabled || signal.aborted || closing) return Promise.resolve('cancelled');
      if(pending) return Promise.resolve('busy');
      if(typeof loginRequired!=='boolean' && loginRequired!=='detect') return Promise.resolve('failed');
      controller=new AbortController();
      const combined=AbortSignal.any([signal,controller.signal]);
      const check=()=>{if(disabled || combined.aborted) throw Error('SETUP_CANCELLED');};
      pending=Promise.resolve().then(async():Promise<Outcome>=>{
        let accepted=false;
        gate.revoke();
        try {
          check();
          let snapshot:Awaited<ReturnType<typeof attest>>|undefined;
          if(loginRequired==='detect') {
            try {snapshot=await attest(combined);loginRequired=false;}
            catch(error) {
              if(!(error instanceof Error) || error.message!=='OBSERVER_LOGIN_REQUIRED') throw error;
              loginRequired=true;
            }
            check();
          }
          if(loginRequired) {
            const answer=await prompt(dialog.showMessageBox({type:'question',title:'Codex Progress HUD：独立登录',
              message:'现在为插件登录 ChatGPT 吗？',
              detail:'将打开浏览器完成独立登录，可使用与主 Codex 相同的账户和订阅。不复制主 Codex 的登录令牌，凭据保存在插件本机私有目录。登录后还会单独询问任务内容与额外用量授权。日常开关仍在 Codex 插件页。',
              buttons:['开始登录','暂不登录'],defaultId:1,cancelId:1,noLink:true}),combined);
            check();
            if(answer.response!==0) return 'declined';
            const outcome=await login.login(combined);
            check();
            if(outcome!=='process_exited') return outcome==='cancelled'?'cancelled':'failed';
          }
          snapshot ??= await attest(combined);
          check();
          gate.update(snapshot.evidence);
          if(!gate.offer()) return 'failed';
          const consent=await prompt(requestObserverConsent(gate,dialog,snapshot.accountLabel),combined);
          check();
          accepted=consent && gate.authorized();
          return accepted?'authorized':'declined';
        } catch {return combined.aborted || disabled?'cancelled':'failed';}
        finally {if(!accepted) gate.revoke();}
      }).finally(()=>{pending=undefined;controller=undefined;});
      return pending;
    },
    disable,
    close():Promise<void> {
      if(closing) return closing;
      disable();const operation=pending;
      closing=(async()=>{await operation;await login.close();})();
      return closing;
    },
  };
}
