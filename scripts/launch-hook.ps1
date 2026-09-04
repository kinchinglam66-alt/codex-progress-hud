param(
  [string] $HookName
)

$ErrorActionPreference = "Stop"

function Stop-Launcher {
  [Console]::Out.WriteLine('{"continue":true}')
  [Console]::Error.WriteLine("Codex Progress HUD Hook launcher skipped: unavailable")
  exit 0
}

try {
  $supportedHooks = @("SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd")
  if ([string]::IsNullOrWhiteSpace($HookName) -or -not $supportedHooks.Contains($HookName)) {
    throw "unsupported Hook event"
  }
  if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    throw "missing app data directory"
  }

  $manifestPath = Join-Path $env:APPDATA "codex-progress-hud\install.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "installed manifest is unavailable"
  }

  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $properties = @($manifest.PSObject.Properties.Name)
  if ($properties.Count -ne 3 -or
      -not $properties.Contains("executablePath") -or
      -not $properties.Contains("installDirectory") -or
      -not $properties.Contains("version")) {
    throw "installed manifest is invalid"
  }

  $executablePath = [string] $manifest.executablePath
  $installDirectory = [string] $manifest.installDirectory
  $version = ([string] $manifest.version).Trim()
  if ([string]::IsNullOrWhiteSpace($executablePath) -or
      [string]::IsNullOrWhiteSpace($installDirectory) -or
      [string]::IsNullOrWhiteSpace($version) -or
      -not [IO.Path]::IsPathRooted($executablePath) -or
      -not [IO.Path]::IsPathRooted($installDirectory)) {
    throw "installed manifest is invalid"
  }

  $fullInstallDirectory = [IO.Path]::GetFullPath($installDirectory)
  $fullExecutablePath = [IO.Path]::GetFullPath($executablePath)
  $expectedExecutablePath = [IO.Path]::GetFullPath(
    (Join-Path $fullInstallDirectory "Codex Progress HUD.exe")
  )
  if (-not [string]::Equals($fullExecutablePath, $expectedExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "installed executable is outside the validated install directory"
  }
  if (-not (Test-Path -LiteralPath $fullInstallDirectory -PathType Container) -or
      -not (Test-Path -LiteralPath $fullExecutablePath -PathType Leaf)) {
    throw "installed executable is unavailable"
  }

  $resolvedExecutablePath = (Resolve-Path -LiteralPath $fullExecutablePath).Path
  if (-not [string]::Equals(
      [IO.Path]::GetFullPath($resolvedExecutablePath),
      $fullExecutablePath,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw "installed executable path is not canonical"
  }

  $entryScript = Join-Path $fullInstallDirectory "resources\app.asar\dist\main.js"
  . (Join-Path $PSScriptRoot "invoke-node-mode.ps1")
  $exitCode = Invoke-CodexProgressHudNodeMode $fullExecutablePath $entryScript "--hook-event=$HookName"
  if ($exitCode -ne 0) {
    exit $exitCode
  }
  exit 0
}
catch {
  Stop-Launcher
}
