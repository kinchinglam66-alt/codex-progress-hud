param([Parameter(Mandatory=$true)][string]$ParentDirectory, [switch]$VerifyOnly)
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

try {
    if ($ParentDirectory -notmatch '^[a-zA-Z]:[\\/]' -or $ParentDirectory -match '[\x00-\x1f\x7f]') { throw 'invalid path' }
    $parentPath = [System.IO.Path]::GetFullPath($ParentDirectory).TrimEnd('\', '/')
    if ($parentPath.Length -le 3) { throw 'root parent' }
    Assert-PlainDirectory $parentPath
    $targetPath = [System.IO.Path]::Combine($parentPath, 'observer-auth')
    $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
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
            if ($fileAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $userSid.Value) { throw 'invalid credentials owner' }
            foreach ($fileRule in $fileAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
                if ($fileRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                    $fileRule.IdentityReference.Value -notin $allowed) { throw 'permissive credentials access' }
            }
        }
    }
    @{ok=$true; path=$targetPath} | ConvertTo-Json -Compress
    exit 0
} catch {
    Write-Output '{"ok":false,"code":"OBSERVER_HOME_UNAVAILABLE"}'
    exit 1
}
