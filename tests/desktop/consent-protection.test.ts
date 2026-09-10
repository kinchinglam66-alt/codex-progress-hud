import {expect,it} from 'vitest';
import {createSafeStorageConsentProtection} from '../../src/desktop/consent-protection.js';

it('uses OS-backed storage lazily and rejects ciphertext from the old derived-key format',()=>{
  let available=false,encryptions=0;
  const protection=createSafeStorageConsentProtection({isEncryptionAvailable:()=>available,
    encryptString:value=>{encryptions++;return Buffer.from(`os-sealed:${value}`);},
    decryptString:value=>value.toString().slice('os-sealed:'.length)});
  expect(()=>protection.protect('grant')).toThrow('CONSENT_PROTECTION_UNAVAILABLE');
  expect(encryptions).toBe(0);
  available=true;
  const sealed=protection.protect('grant') as string;
  expect(protection.unprotect(sealed)).toBe('grant');
  expect(protection.unprotect('v1:iv:tag:old-ciphertext')).toBeNull();
});

it('does not fall back to plaintext storage when the OS backend is unavailable or basic_text',()=>{
  const protection=createSafeStorageConsentProtection({isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'basic_text',
    encryptString:()=>{throw Error('must not encrypt');},decryptString:()=>{throw Error('must not decrypt');}},'linux');
  expect(()=>protection.protect('grant')).toThrow('CONSENT_PROTECTION_UNAVAILABLE');
  expect(()=>protection.unprotect('os-v1:YQ==')).toThrow('CONSENT_PROTECTION_UNAVAILABLE');
});
it('does not call the Linux-only backend selector on Windows',()=>{
  const protection=createSafeStorageConsentProtection({isEncryptionAvailable:()=>true,
    getSelectedStorageBackend:()=>{throw Error('Linux-only API');},
    encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()},'win32');
  expect(protection.unprotect(protection.protect('grant') as string)).toBe('grant');
});
