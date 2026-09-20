$ErrorActionPreference = "Stop"

function Fail-Launcher([int] $Code, [string] $Message) {
  [Console]::Error.WriteLine($Message)
  exit $Code
}

try {
  if ([string]::IsNullOrWhiteSpace($env:USERPROFILE) -and [string]::IsNullOrWhiteSpace($env:CODEX_PROGRESS_HUD_DATA_DIR)) {
    Fail-Launcher 2 "COMPANION_NOT_INSTALLED: Install Codex Progress HUD and retry."
  }
  $dataDirectory = if ($env:CODEX_PROGRESS_HUD_DATA_DIR) { $env:CODEX_PROGRESS_HUD_DATA_DIR } else { Join-Path $env:USERPROFILE '.codex-progress-hud' }
  if (-not [IO.Path]::IsPathRooted($dataDirectory)) { throw 'invalid data directory' }
  $manifestPath = Join-Path $dataDirectory 'install.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Fail-Launcher 2 "COMPANION_NOT_INSTALLED: Install Codex Progress HUD and retry."
  }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $properties = @($manifest.PSObject.Properties.Name)
  if ($properties.Count -ne 3 -or -not $properties.Contains("executablePath") -or -not $properties.Contains("installDirectory") -or -not $properties.Contains("version")) {
    Fail-Launcher 3 "INVALID_INSTALL_MANIFEST: Reinstall Codex Progress HUD."
  }
  $installDirectory = [IO.Path]::GetFullPath([string]$manifest.installDirectory)
  $executablePath = [IO.Path]::GetFullPath([string]$manifest.executablePath)
  $expectedExecutable = [IO.Path]::GetFullPath((Join-Path $installDirectory "Codex Progress HUD.exe"))
  if (-not [string]::Equals($executablePath, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
    Fail-Launcher 3 "INVALID_INSTALL_MANIFEST: Executable is outside the install directory."
  }
  if (-not (Test-Path -LiteralPath $installDirectory -PathType Container) -or -not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    Fail-Launcher 4 "COMPANION_EXECUTABLE_MISSING: Reinstall Codex Progress HUD."
  }
  $resolvedExecutable = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $executablePath).Path)
  if (-not [string]::Equals($resolvedExecutable, $executablePath, [StringComparison]::OrdinalIgnoreCase)) {
    Fail-Launcher 3 "INVALID_INSTALL_MANIFEST: Executable path is not canonical."
  }
  $entryScript = Join-Path $installDirectory "resources\app.asar\dist\main.js"
  . (Join-Path $PSScriptRoot "invoke-node-mode.ps1")
  exit (Invoke-CodexProgressHudNodeMode $executablePath $entryScript "--mcp-stdio")
} catch {
  Fail-Launcher 3 "INVALID_INSTALL_MANIFEST: Reinstall Codex Progress HUD."
}
