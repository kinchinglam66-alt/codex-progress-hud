# Threat model

## Assets

- Local task metadata shown by the HUD.
- The bearer token protecting the local API.
- Integrity of lifecycle state, progress, and ETA.
- User attention: false completion and false precision can cause harmful decisions.

## Trust boundaries

The Electron main process, renderer, MCP server process, executing model, Codex host, and local operating-system account are separate boundaries. Model output and MCP arguments are untrusted. Other processes running as the same OS user are not assumed benign.

## Main threats and mitigations

### Unauthorized local reads or writes

Every API route requires a high-entropy token. The service binds only to loopback, uses constant-time token comparison, rejects oversized bodies, and does not enable CORS. The Electron session injects authentication without exposing the token to renderer JavaScript.

Residual risk: malware or a process with access to the user's application-data directory can read the token. Stronger future options include OS credential storage and named-pipe access control.

### Prompt injection and malicious reports

All fields are schema-validated and length-limited. Reports cannot request shell execution or file access. Explicit runtime failure and interruption outrank cooperative model completion claims.

Residual risk: a model can still provide plausible but inaccurate semantic progress. The UI displays ranges and verification distinctions rather than asserting certainty.

### Sensitive information leakage

The skill forbids raw prompts, reasoning, code, files, credentials, and command output. The MVP stores no task records and sends no telemetry. UI text should still be treated as potentially visible in screen sharing and screenshots.

### Renderer compromise

The renderer is sandboxed, has no Node integration, receives a restrictive Content Security Policy, and loads only local resources. API authentication is added by the isolated Electron session.

### Dependency and release compromise

The lockfile is committed, CI uses `npm ci`, and Dependabot monitors dependencies. Release packaging must add artifact signing and checksums before binaries are published.

### Unsupported Codex integration

The project does not scrape or patch the Codex GUI. A future App Server bridge must use documented schemas, pin tested compatibility ranges, and degrade to cooperative MCP reporting when authoritative events are unavailable.

