$ErrorActionPreference = "Stop"

try {
  if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) { exit 0 }
  $dataDirectory = if ($env:CODEX_PROGRESS_HUD_DATA_DIR) { $env:CODEX_PROGRESS_HUD_DATA_DIR } else { Join-Path $env:USERPROFILE '.codex-progress-hud' }
  $tokenPath = Join-Path $dataDirectory "auth.token"
  if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { exit 0 }
  $token = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
  if ([string]::IsNullOrWhiteSpace($token)) { exit 0 }
  $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:17837/api/shutdown')
  $request.Proxy = $null
  $request.Method = 'POST'
  $request.Timeout = 5000
  $request.Headers['Authorization'] = "Bearer $token"
  $request.ContentType = 'application/json'
  $body = [Text.Encoding]::UTF8.GetBytes('{}')
  $request.ContentLength = $body.Length
  $stream = $request.GetRequestStream()
  try { $stream.Write($body,0,$body.Length) } finally { $stream.Dispose() }
  $response = $request.GetResponse()
  $response.Dispose()
} catch {
  exit 0
}
exit 0
