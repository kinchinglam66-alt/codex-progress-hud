$ErrorActionPreference = "Stop"

try {
  if ([string]::IsNullOrWhiteSpace($env:APPDATA)) { exit 0 }
  $dataDirectory = Join-Path $env:APPDATA "codex-progress-hud"
  $tokenPath = Join-Path $dataDirectory "auth.token"
  if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { exit 0 }
  $token = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
  if ([string]::IsNullOrWhiteSpace($token)) { exit 0 }
  Invoke-WebRequest -UseBasicParsing -Method Post `
    -Uri "http://127.0.0.1:17837/api/shutdown" `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType "application/json" -Body "{}" | Out-Null
} catch {
  exit 0
}
exit 0
