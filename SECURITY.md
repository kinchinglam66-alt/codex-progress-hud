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

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for detailed assumptions and residual risks.

