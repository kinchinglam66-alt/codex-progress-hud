import type {ConsentProtection} from '../estimation/observer-consent-store.js';

interface SafeStorageLike {
  isEncryptionAvailable():boolean;
  encryptString(value:string):Buffer;
  decryptString(value:Buffer):string;
  getSelectedStorageBackend?():string;
}

/** Desktop-only OS protection, checked lazily after app readiness. No derived-key fallback. */
export function createSafeStorageConsentProtection(storage:SafeStorageLike,platform:NodeJS.Platform=process.platform):ConsentProtection {
  const check=()=>{
    if(!storage.isEncryptionAvailable()||(platform==='linux'&&storage.getSelectedStorageBackend?.()==='basic_text'))
      throw Error('CONSENT_PROTECTION_UNAVAILABLE');
  };
  return {
    protect(value){check();return `os-v1:${storage.encryptString(value).toString('base64')}`;},
    unprotect(value){
      check();
      if(!/^os-v1:[A-Za-z0-9+/]+={0,2}$/u.test(value))return null;
      try{return storage.decryptString(Buffer.from(value.slice(6),'base64'));}catch{return null;}
    }
  };
}
