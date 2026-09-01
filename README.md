# Codex Progress HUD

A local, privacy-first desktop overlay for Codex task status, structured progress, and honest remaining-time ranges.

> Community project. Not affiliated with, endorsed by, or sponsored by OpenAI. “Codex” is used only to describe compatibility with the Codex product.

## What works in the MVP

- Frameless always-on-top Electron overlay for Windows, with portable core code.
- Structured `progress_report`, `task_outcome`, and `task_status` MCP tools.
- Deterministic lifecycle states that distinguish waiting, failure, interruption, unverified completion, and verified success.
- ETA ranges combining observed plan throughput with the executing model's estimate and confidence.
- Loopback-only authenticated HTTP/SSE transport.
- Chinese compact HUD labels; the internal data model is locale-neutral.

The MVP does not inject UI into undocumented Codex desktop surfaces and does not scrape the Codex window. Automatic attachment to the private App Server instance used by the stock desktop GUI is not guaranteed. A future bridge can feed documented App Server notifications into the existing reducer.

## Quick start

Requirements: Node.js 22 or newer and a current Codex installation.

```powershell
npm ci
npm test -- --run
npm run build
npm start
```

The overlay listens on `127.0.0.1:17837`. Override the port with `CODEX_PROGRESS_HUD_PORT`. The local bearer token is generated under the user's application-data directory; never copy it into the repository.

Build the project before loading the plugin so `.mcp.json` can start `dist/mcp/main.js`. During local plugin development, clone this repository as `codex-progress-hud` under your personal Codex plugins directory, add it through your personal marketplace, then open a new Codex task so the updated skill and tools are loaded.

## How progress is calculated

The HUD treats runtime lifecycle events as authoritative and model reports as cooperative semantic evidence. Explicit runtime failure or interruption cannot be overwritten by a model saying that it finished.

When plan progress is measurable, the first ETA signal is:

```text
remaining ≈ active elapsed × (1 − completed weight) / completed weight
```

The estimator blends that value with the executing model's structured estimate according to reported confidence. Exploration widens the interval and lowers confidence. Waiting and terminal states return no active-work ETA.

This is intentionally a range, not a precise countdown. The current estimator is a transparent baseline intended for calibration with opt-in, content-free historical timing samples.

## MCP reporting contract

The bundled skill asks Codex to report on task start, plan changes, phase changes, waiting states, validation failures, and terminal outcomes. Reports contain concise display-safe metadata only:

- Task identifier and short title.
- Current phase and step.
- Optional `0..1` progress and confidence.
- Optional low/high remaining active-work seconds.
- Waiting reason or final semantic outcome.

Prompts, hidden reasoning, source code, command output, file contents, and credentials must not be reported.

## Development

```powershell
npm test -- --run
npm run typecheck
npm run build
npm run validate:plugin
```

Architecture and implementation records are under `docs/superpowers/`. Security boundaries are documented in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Open-source checklist before publishing a fork

- Update package and plugin author metadata to the real maintainer identity.
- Add the final GitHub repository, homepage, privacy-policy, and security-contact URLs.
- Enable GitHub private vulnerability reporting, branch protection, Dependabot, and required CI checks.
- Review every dependency license and generated binary before a release.
- Sign release artifacts and publish checksums when installers are added.
- Test plugin loading against the minimum and latest supported Codex versions.
- Do not upload local token files, task snapshots, logs, `.env` files, or screenshots containing private work.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

