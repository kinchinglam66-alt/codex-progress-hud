# Security policy

## Supported versions

Security fixes are applied to the latest minor release. Before the first public release, the `main` branch is the only supported line.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature from the repository Security tab. Do not open a public issue containing exploit details, tokens, private task data, prompts, source code from unrelated projects, or command output.

If private vulnerability reporting is unavailable, open a public issue containing only a request for a private maintainer contact. Maintainers should acknowledge a complete report within seven days and coordinate disclosure after a fix is available.

## Security boundaries

- The HTTP service must remain bound to loopback.
- All API reads, writes, and event streams require the local bearer token.
- The renderer has no Node integration and runs with context isolation and sandboxing.
- Model-provided fields are untrusted and validated before entering the reducer.
- The project does not treat model text as proof of runtime success.
- Release installers are unsigned until a trusted code-signing certificate is configured; verify the published SHA-256 checksums before execution.
- Packaged launchers accept only the installer-written exact executable path and never invoke a shell-selected Node runtime.

See [docs/THREAT_MODEL.md](https://github.com/kinchinglam66-alt/codex-progress-hud/blob/main/docs/THREAT_MODEL.md) for detailed assumptions and residual risks.
