param([Parameter(Mandatory=$true)][string]$RuntimeHome)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function Assert-Plain([string]$nativePath) {
  $nativeCursor=$nativePath
  while($nativeCursor) {
    $nativeAttributes=[IO.File]::GetAttributes($nativeCursor)
    if(($nativeAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
       ($nativeAttributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'directory' }
    $nativeParent=[IO.Directory]::GetParent($nativeCursor)
    if($null -eq $nativeParent) { break }
    $nativeCursor=$nativeParent.FullName
  }
}
function Assert-Protected([string]$nativePath) {
  Assert-Plain $nativePath
  $nativeAcl=[IO.Directory]::GetAccessControl($nativePath)
  if(-not $nativeAcl.AreAccessRulesProtected -or
     $nativeAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $nativeUser.Value) { throw 'owner' }
  $nativeHasUser=$false
  foreach($nativeRule in $nativeAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if($nativeRule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      if($nativeRule.IdentityReference.Value -notin $nativeAllowed -or $nativeRule.IsInherited) { throw 'access' }
      if($nativeRule.IdentityReference.Value -eq $nativeUser.Value -and
        ($nativeRule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and
        ($nativeRule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0 -and
        ($nativeRule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0 -and
        $nativeRule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None) { $nativeHasUser=$true }
    }
  }
  if(-not $nativeHasUser) { throw 'inheritance' }
}
function Test-Owner([long]$nativePid,[string]$nativeIdentity) {
  $nativeProcess=$null
  try {
    # .NET takes signed Int32. Out-of-range identities are unconfirmed, never exited.
    if($nativePid -gt [int]::MaxValue) { throw 'pid' }
    try { $nativeProcess=[Diagnostics.Process]::GetProcessById([int]$nativePid) }
    catch [ArgumentException] { return 'exited' }
    $null=$nativeProcess.Handle
    if($nativeProcess.HasExited) { return 'exited' }
    $nativeActual=$nativeProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    if($nativeActual -ne $nativeIdentity) { return 'exited' }
    return 'live'
  } finally { if($null -ne $nativeProcess) { $nativeProcess.Dispose() } }
}
try {
  if($RuntimeHome -cnotmatch '^[a-zA-Z]:[\\/]' -or $RuntimeHome -match '[\x00-\x1f\x7f]' -or
     [IO.Path]::GetFileName($RuntimeHome) -ine 'observer-auth') { throw 'home' }
  $nativeHome=[IO.Path]::GetFullPath($RuntimeHome)
  $nativeUser=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $nativeAllowed=@($nativeUser.Value,'S-1-5-18','S-1-5-32-544')
  $nativeRoot=[IO.Path]::Combine($nativeHome,'hud-native')
  $nativeInput=[Console]::OpenStandardInput()
  $nativeLastId=[long]0
  while($true) {
    $nativeLine=New-Object Text.StringBuilder
    while($true) {
      $nativeByte=$nativeInput.ReadByte()
      if($nativeByte -eq -1) {
        if($nativeLine.Length -eq 0) { exit 0 }
        throw 'partial'
      }
      if($nativeByte -eq 10) { break }
      if($nativeByte -lt 32 -or $nativeByte -gt 126 -or $nativeLine.Length -ge 255) { throw 'frame' }
      [void]$nativeLine.Append([char]$nativeByte)
    }
    $nativeText=$nativeLine.ToString()
    # Canonical grammar also rejects duplicate/extra properties and JSON escapes.
    if($nativeText -cmatch '^\{"v":1,"id":([1-9][0-9]*),"op":"verify_storage"\}$') {
      $nativeId=[long]$Matches[1];$nativeOp='verify_storage'
      $nativeOwnerPid=$null;$nativeOwnerIdentity=$null
    } elseif($nativeText -cmatch '^\{"v":1,"id":([1-9][0-9]*),"op":"owner_exited","pid":([1-9][0-9]*),"creationIdentity":"([0-9]{1,20})"\}$') {
      $nativeId=[long]$Matches[1];$nativeOp='owner_exited'
      $nativeOwnerPid=[long]$Matches[2];$nativeOwnerIdentity=$Matches[3]
      if($nativeOwnerPid -gt 4294967295) { throw 'pid' }
    } else { throw 'frame' }
    if($nativeId -le $nativeLastId -or $nativeId -gt 9007199254740991) { throw 'id' }
    $nativeLastId=$nativeId
    if($nativeOp -eq 'verify_storage') {
      foreach($nativeTarget in @($nativeHome,$nativeRoot,[IO.Path]::Combine($nativeRoot,'snapshots'),[IO.Path]::Combine($nativeRoot,'custody'),$nativeHome)) {
        Assert-Protected $nativeTarget
      }
      $nativeResult='ok'
    } else { $nativeResult=Test-Owner $nativeOwnerPid $nativeOwnerIdentity }
    $nativeReply='{"v":1,"id":'+$nativeId.ToString([Globalization.CultureInfo]::InvariantCulture)+',"op":"'+$nativeOp+'","result":"'+$nativeResult+'"}'
    [Console]::Out.Write($nativeReply+"`n")
    [Console]::Out.Flush()
  }
} catch { exit 1 }
