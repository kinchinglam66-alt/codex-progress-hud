param([Parameter(Mandatory=$true)][string]$ParentDirectory, [switch]$VerifyOnly, [switch]$Persistent)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Assert-PlainDirectory([string]$Directory) {
    $cursor = $Directory
    while ($cursor) {
        $attributes = [System.IO.File]::GetAttributes($cursor)
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { throw 'invalid directory' }
        $parent = [System.IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Invoke-HomeCheck([string]$ParentDirectory, [bool]$VerifyOnly) {
try {
    if ($ParentDirectory -notmatch '^[a-zA-Z]:[\\/]' -or $ParentDirectory -match '[\x00-\x1f\x7f]') { throw 'invalid path' }
    $parentPath = [System.IO.Path]::GetFullPath($ParentDirectory).TrimEnd('\', '/')
    if ($parentPath.Length -le 3) { throw 'root parent' }
    Assert-PlainDirectory $parentPath
    $targetPath = [System.IO.Path]::Combine($parentPath, 'observer-auth')
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $userSid = $identity.User
    $allowed = @($userSid.Value, 'S-1-5-18', 'S-1-5-32-544')
    if (-not [System.IO.Directory]::Exists($targetPath)) {
        if ($VerifyOnly -or [System.IO.File]::Exists($targetPath)) { throw 'missing directory' }
        $security = New-Object System.Security.AccessControl.DirectorySecurity
        $security.SetOwner($userSid)
        $security.SetAccessRuleProtection($true, $false)
        foreach ($sidValue in $allowed) {
            $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
                ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow)
            $security.AddAccessRule($rule)
        }
        # .NET applies the protected descriptor at creation; no inherited-open window.
        [void][System.IO.Directory]::CreateDirectory($targetPath, $security)
    }
    Assert-PlainDirectory $targetPath
    $actual = [System.IO.Directory]::GetAccessControl($targetPath)
    if (-not $actual.AreAccessRulesProtected -or
        $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $userSid.Value) { throw 'invalid owner' }
    $hasUser = $false
    foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
            if ($rule.IdentityReference.Value -notin $allowed -or $rule.IsInherited) { throw 'permissive access' }
            if ($rule.IdentityReference.Value -eq $userSid.Value -and
                ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
                $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None) { $hasUser = $true }
        }
    }
    if (-not $hasUser) { throw 'missing user access' }
    # Setup commands can read local configuration. This owned home deliberately
    # has no user config: all supported settings come from pinned launch options.
    # Inspect metadata only; never read credential bytes or echo file names.
    $entryCount = 0
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($targetPath)) {
        $entryCount++
        if ($entryCount -gt 256) { throw 'too many entries' }
        $name = [System.IO.Path]::GetFileName($entry)
        $attributes = [System.IO.File]::GetAttributes($entry)
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'linked entry' }
        if ($name -ieq 'config.toml') { throw 'unapproved config' }
        if ($name -ieq 'auth.json') {
            if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) { throw 'invalid credentials file' }
            $fileAcl = [System.IO.File]::GetAccessControl($entry)
            $fileOwner = $fileAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            # Elevated Windows processes may create files owned by Administrators.
            # Do not accept that group owner from a non-elevated caller.
            $adminOwnerAllowed = $fileOwner -eq 'S-1-5-32-544' -and
                ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
            if ($fileOwner -ne $userSid.Value -and -not $adminOwnerAllowed) { throw 'invalid credentials owner' }
            foreach ($fileRule in $fileAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
                if ($fileRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                    $fileRule.IdentityReference.Value -notin $allowed) { throw 'permissive credentials access' }
            }
        }
    }
    return @{ok=$true; path=$targetPath}
} catch {
    return @{ok=$false; code='OBSERVER_HOME_UNAVAILABLE'}
}
}

if (-not $Persistent) {
    $result = Invoke-HomeCheck $ParentDirectory ([bool]$VerifyOnly)
    $result | ConvertTo-Json -Compress
    if ($result.ok) { exit 0 } else { exit 1 }
}

# The launch binds the directory. Requests have no paths or executable input.
# ASCII-only request framing makes the 256-byte bound independent of encoding.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$lastId = 0L
try {
    while ($true) {
        $line = ''
        while ($true) {
            $ch = [Console]::In.Read()
            if ($ch -eq -1) { if ($line.Length -ne 0) { throw 'incomplete frame' }; exit 0 }
            if ($ch -eq 10) { break }
            if ($ch -lt 32 -or $ch -gt 126 -or $line.Length -ge 255) { throw 'invalid frame' }
            $line += [char]$ch
        }
        $request = $line | ConvertFrom-Json
        if ($null -eq $request -or ($request.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'id,op,v' -or
            $request.v -ne 1 -or ($request.v -isnot [int] -and $request.v -isnot [long]) -or
            ($request.id -isnot [int] -and $request.id -isnot [long]) -or
            $request.id -le $lastId -or $request.id -gt 9007199254740991 -or
            ($request.op -cne 'prepare' -and $request.op -cne 'verify')) { throw 'invalid request' }
        $lastId = $request.id
        $result = Invoke-HomeCheck $ParentDirectory ($request.op -ceq 'verify')
        $result.v = 1
        $result.id = $lastId
        $serialized = $result | ConvertTo-Json -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($serialized) -ge 4096) { throw 'oversized response' }
        [Console]::Out.WriteLine($serialized)
        [Console]::Out.Flush()
        if (-not $result.ok) { exit 1 }
    }
} catch {
    exit 1
}
