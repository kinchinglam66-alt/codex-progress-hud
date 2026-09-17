import {expect,it} from 'vitest';
import {createApprovedComparisonConsent} from '../../src/evaluation/native-comparison-consent.js';
const original={accountFingerprint:'a'.repeat(64),routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64),observedAt:0,expiresAt:300000};
it('refreshes attestation after ordinary waiting without extending it or changing the approved scope',()=>{
 let now=0,invalidated=0;
 const consent=createApprovedComparisonConsent(original,{now:()=>now,onInvalidate:()=>{invalidated++;}});
 expect(consent.authorized()).toBe(true);
 now=300001;
 consent.refresh({...original,observedAt:299000,expiresAt:599000});
 expect(consent.authorized()).toBe(true);expect(invalidated).toBe(0);
 now=599000;expect(consent.authorized()).toBe(false);expect(invalidated).toBe(1);
 expect(()=>consent.refresh({...original,observedAt:599000,expiresAt:899000})).toThrow('TRIAL_CONSENT_REVOKED');
});
it.each(['accountFingerprint','routeFingerprint','assetsFingerprint'] as const)('rejects a changed %s instead of treating new metadata as new approval',key=>{
 let now=0;
 const consent=createApprovedComparisonConsent(original,{now:()=>now,onInvalidate:()=>{}});
 now=300001;
 expect(()=>consent.refresh({...original,[key]:'d'.repeat(64),observedAt:300000,expiresAt:600000})).toThrow('TRIAL_ACCOUNT_BINDING_CHANGED');
 expect(consent.authorized()).toBe(false);
});
it('does not authorize stale metadata or a changed recipient after refresh',()=>{
 let now=0;
 const stale=createApprovedComparisonConsent(original,{now:()=>now,onInvalidate:()=>{}});
 now=300001;expect(()=>stale.refresh(original)).toThrow('TRIAL_ATTESTATION_UNAVAILABLE');expect(stale.authorized()).toBe(false);
 now=0;const changed=createApprovedComparisonConsent(original,{now:()=>now,onInvalidate:()=>{}});
 now=300001;
 expect(()=>changed.refresh({...original,recipientFingerprint:'e'.repeat(64),observedAt:300000,expiresAt:600000})).toThrow('TRIAL_CONSENT_SCOPE_CHANGED');
 expect(changed.authorized()).toBe(false);
});
it('does not reset clock-reversal protection when replacing an attestation',()=>{
 let now=1000;
 const consent=createApprovedComparisonConsent(original,{now:()=>now,onInvalidate:()=>{}});
 now=999;
 expect(()=>consent.refresh({...original,observedAt:999,expiresAt:300999})).toThrow('TRIAL_ATTESTATION_UNAVAILABLE');
 expect(consent.authorized()).toBe(false);
});
