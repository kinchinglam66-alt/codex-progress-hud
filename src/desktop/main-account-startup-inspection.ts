import type {ObserverAccountSnapshot} from './observer-account-settings.js';
import type {MainCodexAccountSnapshot} from '../estimation/main-codex-account-source.js';

/** Reuses remote evidence only within the owning startup. The local read is
 * a current identity fence, not a replacement for remote authentication. */
export function createMainStartupInspection(snapshot:ObserverAccountSnapshot,
  source:{inspect(signal:AbortSignal):Promise<MainCodexAccountSnapshot>}) {
  const captured={accountLabel:snapshot.accountLabel,evidence:{...snapshot.evidence}};
  let consumed=false;
  return async(signal:AbortSignal):Promise<ObserverAccountSnapshot>=>{
    if(consumed)throw Error('OBSERVER_STARTUP_INSPECTION_CONSUMED');
    consumed=true;signal.throwIfAborted();
    const current=await source.inspect(signal);signal.throwIfAborted();
    if(current.accountFingerprint!==captured.evidence.accountFingerprint)throw Error('OBSERVER_ACCOUNT_BINDING_CHANGED');
    return {...captured,evidence:{...captured.evidence}};
  };
}
