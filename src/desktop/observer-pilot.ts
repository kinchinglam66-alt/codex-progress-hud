import {resolve} from 'node:path';
import {readObserverPilotConfig,observerPilotEnvironment} from './observer-pilot-config.js';
import {createObserverIdentityRuntime} from '../estimation/observer-identity-runtime.js';
import {openThreadedReleaseAccounting} from '../estimation/accounting-worker-owner.js';
import {createDesktopObserverRuntime} from './observer-runtime.js';
import {createPilotJournal} from '../evaluation/pilot-journal.js';
import type {ObserverConsentDialog} from './observer-consent-dialog.js';
import {createObserverConsentStore,type ConsentProtection} from '../estimation/observer-consent-store.js';

/** Explicit local pilot opt-in, never configuration taken from a chat/HTTP request.
 * Construction reads settings only. Account/process work begins after HUD readiness. */
export async function loadDesktopObserverPilot(options:{dataDirectory:string;resourcesDirectory:string;dialog:ObserverConsentDialog;environment:NodeJS.ProcessEnv;consentProtection:ConsentProtection}) {
  const config=await readObserverPilotConfig(resolve(options.dataDirectory,'observer-pilot.json'));
  if(!config)return null;
  const systemRoot=options.environment.SystemRoot??options.environment.SYSTEMROOT;
  if(!systemRoot)throw Error('OBSERVER_PILOT_CONFIG_INVALID');
  const identity=createObserverIdentityRuntime({...config,resourcesDirectory:options.resourcesDirectory,
    powershell:resolve(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    environment:observerPilotEnvironment(config,options.environment)});
  const journal=createPilotJournal(resolve(options.dataDirectory,'pilot-observations'));
  const consentStore=createObserverConsentStore(resolve(options.dataDirectory,'observer-consent.json'),options.consentProtection);
  const runtime=createDesktopObserverRuntime({identity,dialog:options.dialog,
    openAccounting:()=>openThreadedReleaseAccounting(resolve(options.dataDirectory,'observer-accounting'),Date.now), consentStore});
  return {workers:runtime.workers,onObservation:journal.record,schedulerRecovery:runtime.schedulerRecovery,
    recovery: runtime.recovery,
    start:runtime.start,disable:runtime.disable,revokeConsent:runtime.revokeConsent,
    async close(){try{await runtime.close();}finally{await journal.close();}}};
}
