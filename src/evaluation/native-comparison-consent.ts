import {createObserverConsentGate,observerConsentScope,type ObserverAttestation} from '../estimation/observer-consent.js';
import type {ObserverConsentGrant} from '../estimation/observer-consent-store.js';

/** Diagnostic only: the user approved this experiment's fixed recipient/scope.
 * Fresh account evidence can restore that grant, never authorize a new binding.
 * Production gate TTL/revocation behavior is intentionally unchanged. */
export function createApprovedComparisonConsent(initial:ObserverAttestation,options:{now:()=>number;onInvalidate:()=>void}){
 let revoked=false,lastClock=0;
 const now=()=>{
  const value=options.now();
  if(!Number.isSafeInteger(value)||value<lastClock)throw Error('TRIAL_CLOCK_INVALID');
  lastClock=value;return value;
 };
 const newGate=()=>createObserverConsentGate({now,onInvalidate:()=>{revoked=true;options.onInvalidate();}});
 const binding=(v:ObserverAttestation)=>JSON.stringify([v.accountFingerprint,v.routeFingerprint,v.assetsFingerprint]);
 let gate=newGate();gate.update(initial);
 const offer=gate.offer();
 if(!offer||!gate.accept(offer))throw Error('TRIAL_CONSENT_UNAVAILABLE');
 const expected=binding(initial),scope=observerConsentScope(initial);
 Object.freeze(scope.dataCategories);Object.freeze(scope);
 const grant:ObserverConsentGrant=Object.freeze({version:1,scope,grantedAt:now()});
 function fail(code:string):never{revoked=true;gate.revoke();throw Error(code);}
 return {
  authorized:()=>!revoked&&gate.authorized(),
  refresh(evidence:ObserverAttestation):void{
   if(revoked)throw Error('TRIAL_CONSENT_REVOKED');
   if(binding(evidence)!==expected)fail('TRIAL_ACCOUNT_BINDING_CHANGED');
   const candidate=newGate();candidate.update(evidence);
   if(!candidate.offer())fail('TRIAL_ATTESTATION_UNAVAILABLE');
   if(!candidate.restore(grant))fail('TRIAL_CONSENT_SCOPE_CHANGED');
   gate=candidate;
  },
 };
}
