import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {basename,isAbsolute,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {resolveObserverAuthHome} from './codex-invocation.js';
import {resolveTrustedPowerShellPath} from './recovery-boot-boundary.js';
const execute=promisify(execFile);

/** Windows-only local storage boundary. Does not inspect credentials or repair
 * an existing permissive ACL. Parent must be the attested independent home. */
export function createNativeStorage(runtimeHome:string){
 const fail=()=>Error('NATIVE_STORAGE_UNAVAILABLE');
 if(process.platform!=='win32'||!isAbsolute(runtimeHome)||!(/^[a-z]:[\\/]/iu.test(runtimeHome))||basename(runtimeHome).toLowerCase()!=='observer-auth'||
   /[\x00-\x1f\x7f]/u.test(runtimeHome))throw fail();
 const home=resolve(runtimeHome),root=join(home,'hud-native');
 try{resolveObserverAuthHome(process.env,home);resolveObserverAuthHome({HOME:homedir()},home);}catch{throw fail();}
 const paths=Object.freeze({snapshots:join(root,'snapshots'),custody:join(root,'custody')});
 async function check(create:boolean,signal:AbortSignal){
  signal.throwIfAborted();
  // Encode the only variable path as data, never PowerShell syntax.
  const encoded=Buffer.from(home,'utf8').toString('base64');
  const command=`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$nativeHome=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$nativeUser=[Security.Principal.WindowsIdentity]::GetCurrent().User
$nativeAllowed=@($nativeUser.Value,'S-1-5-18','S-1-5-32-544')
function Assert-Plain([string]$nativePath) {
  $nativeCursor=$nativePath
  while($nativeCursor) {
    $nativeAttributes=[IO.File]::GetAttributes($nativeCursor)
    if(($nativeAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
       ($nativeAttributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'invalid directory' }
    $nativeParent=[IO.Directory]::GetParent($nativeCursor)
    if($null -eq $nativeParent) { break }
    $nativeCursor=$nativeParent.FullName
  }
}
function Assert-Protected([string]$nativePath) {
  Assert-Plain $nativePath
  $nativeAcl=[IO.Directory]::GetAccessControl($nativePath)
  if(-not $nativeAcl.AreAccessRulesProtected -or
     $nativeAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $nativeUser.Value) { throw 'invalid owner' }
  $nativeHasUser=$false
  foreach($nativeRule in $nativeAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if($nativeRule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      if($nativeRule.IdentityReference.Value -notin $nativeAllowed -or $nativeRule.IsInherited) { throw 'permissive access' }
      if($nativeRule.IdentityReference.Value -eq $nativeUser.Value -and
        ($nativeRule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and
        ($nativeRule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0 -and
        ($nativeRule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0 -and
        $nativeRule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None) { $nativeHasUser=$true }
    }
  }
  if(-not $nativeHasUser) { throw 'missing inheritable user access' }
}
try {
  Assert-Protected $nativeHome
  $nativeRoot=[IO.Path]::Combine($nativeHome,'hud-native')
  foreach($nativeTarget in @($nativeRoot,[IO.Path]::Combine($nativeRoot,'snapshots'),[IO.Path]::Combine($nativeRoot,'custody'))) {
    if(-not [IO.Directory]::Exists($nativeTarget)) {
      if(${create?'$false':'$true'} -or [IO.File]::Exists($nativeTarget)) { throw 'missing storage' }
      Assert-Plain ([IO.Path]::GetDirectoryName($nativeTarget))
      $nativeSecurity=New-Object Security.AccessControl.DirectorySecurity
      $nativeSecurity.SetOwner($nativeUser)
      $nativeSecurity.SetAccessRuleProtection($true,$false)
      foreach($nativeSidValue in $nativeAllowed) {
        $nativeSid=New-Object Security.Principal.SecurityIdentifier($nativeSidValue)
        $nativeRule=New-Object Security.AccessControl.FileSystemAccessRule(
          $nativeSid,[Security.AccessControl.FileSystemRights]::FullControl,
          ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
          [Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
        $nativeSecurity.AddAccessRule($nativeRule)
      }
      [void][IO.Directory]::CreateDirectory($nativeTarget,$nativeSecurity)
    }
    Assert-Protected $nativeTarget
  }
  Assert-Protected $nativeHome
  [Console]::Out.Write('NATIVE_STORAGE_OK')
} catch { [Console]::Out.Write('NATIVE_STORAGE_UNAVAILABLE'); exit 1 }
`;
  try{
   const result=await execute(resolveTrustedPowerShellPath(),['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden',
    '-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:6000,maxBuffer:1024,signal});
   signal.throwIfAborted();
   if(result.stdout!=='NATIVE_STORAGE_OK'||result.stderr!=='')throw fail();
  }catch{throw fail();}
 }
 return {async prepare(signal:AbortSignal){await check(true,signal);return paths;},
   async verify(signal:AbortSignal){await check(false,signal);}};
}
