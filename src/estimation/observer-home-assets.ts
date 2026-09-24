import type {ObserverHomeProfile} from './observer-home.js';
import {isAbsolute, resolve} from 'node:path';
// Reviewed source bytes, not trust-on-first-use. Script changes require explicit
// pin review; the packaging test detects stale or mismatched shipped content.
export const OBSERVER_HOME_SCRIPT_SHA256 = '789a3ebb6ec8f16e01f0fa57e1245e8b0e0c6d2710b8becb607b8cb8de2965cc';
export function observerHomeProfile(resourcesDirectory:string,parentDirectory:string,powershell:string):ObserverHomeProfile {
  if([resourcesDirectory,parentDirectory,powershell].some(path=>typeof path!=='string' || !isAbsolute(path) ||
    /[\x00-\x1f\x7f]/.test(path) || (process.platform==='win32' && !/^[a-z]:[\\/]/i.test(path)))) throw new Error('OBSERVER_HOME_ASSETS_UNAVAILABLE');
  return Object.freeze({parentDirectory:resolve(parentDirectory),powershell:resolve(powershell),
    scriptPath:resolve(resourcesDirectory,'observer-home.ps1'),scriptSha256:OBSERVER_HOME_SCRIPT_SHA256});
}
