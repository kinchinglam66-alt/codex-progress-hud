# Codex Progress HUD

[中文说明](README.zh-CN.md)

Codex Progress HUD is a Windows desktop companion that observes coding-task
activity and displays task state and estimated remaining time. It connects
readable execution history, an optional independent estimator, and a countdown
that accounts for elapsed time and delivery latency.

This is a community research prototype, developed independently of OpenAI.
The desktop interface is primarily Simplified Chinese; the project documentation
and installation entry point are English. See [language support](docs/LANGUAGE.md)
for the main control labels and the role of estimator instructions.

## Research source snapshot

The `research-release-2026-10-24` version is based on upstream commit
`40b81e6bb8f23cd25bcfac3f7c5106b0d3ad58f7`, with reviewed documentation and an
offline example. Runtime and estimator behavior are preserved from that commit.
The embedded package version remains `0.2.1`; that number alone does not identify
an experimental runtime. [Research provenance](docs/RESEARCH-ARTIFACT.md) records
the relationship to the ETA preprint and its separate experimental artifacts.

The distribution prepared here is source code. Installation from a compiled
Windows installer requires matching, published artifacts and checksums; this
snapshot does not supply an installer download. Start with the source workflow.

## What it does

- Observes supported local Codex conversation records and shows separate task rows.
- Builds a readable execution prefix for the current turn and binds each estimate
  to its source, account, and request.
- Supports a user-selected subscription or Responses-compatible API estimator.
- Ages accepted forecasts into a countdown and records stale, missing, or failed
  estimates explicitly.
- Tracks known and unknown usage separately and checks a finite set of supported
  observer runtime versions and hashes.

The settings window asks for explicit estimator authorization. Full-context
estimation can send readable user, assistant, and tool text to the selected
provider without redacting task text, and may consume subscription allowance or
API credit. Review [PRIVACY.md](PRIVACY.md) before enabling it.

## Quick start

Use Windows 10/11 x64, Git, and Node.js 22.13.0 or later. From an extracted source
snapshot or a checkout of the pinned version:

```powershell
npm ci
npm run build
node examples/offline-countdown.mjs
```

The example uses synthetic numbers and imports the actual countdown component.
It reads no conversation, needs no account, and makes no network or model request.

To explore the desktop companion after reviewing its data flow:

```powershell
npm run start:hud
```

Opening the companion is distinct from granting estimator consent. Follow
[Install on Windows](docs/INSTALL-WINDOWS.md) for plugin wiring, matching companion
requirements, and the difference between source and packaged entry points.

## A typical session

1. Build and open the companion, then configure a supported plugin integration.
2. Open **设置** (Settings), inspect the provider and usage notice, and explicitly
   authorize estimation if you want independent forecasts.
3. Continue a task in Codex. The HUD shows supported task activity and any accepted
   forecast. A hidden window or paused tracking does not pause the coding task.
4. Use **撤销估时授权** (Revoke estimator consent) to revoke the saved estimator
   authorization. The Codex plugin page controls plugin enablement.

See [known limitations](docs/KNOWN-LIMITATIONS.md) for compatibility, accuracy,
language, and the distinction between a final response and a correct repair.

## Research and evaluation

The accompanying study is *Execution Information and Estimation Timing for Coding
Agent ETA: An Empirical Study and a Delivery-Aware Framework*, preprint revision
1.7 with editorial revision r2. It compares information packages and estimation
anchors and evaluates selected countdown policies. Its results do not provide a
single accuracy guarantee for this installed companion or every configuration.

The [research materials](research/eta-v1.7/README.md) include derived numeric data,
offline reproduction code, the archived estimator prompt and response schema,
the canonical input builder, structural audit inventories, and protocol disclosures.
Download versioned packages from the
[research release](https://github.com/kinchinglam66-alt/codex-progress-hud/releases/tag/research-release-2026-10-24).
Consult the [artifact map](docs/RESEARCH-ARTIFACT.md) before reproducing a paper table.
Historical task text and execution payloads remain outside the public supplements;
their structural inventories do not enable complete semantic input verification.

## Development

```powershell
npm test -- --run --maxWorkers=1 --no-file-parallelism
npm run typecheck
npm run build
npm run validate:plugin
npm run check:plugin-sync
```

The release manifest records archive hashes and the verification actually performed
for this version. Historical test counts in older technical notes describe their
original revisions. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
and the [threat model](docs/THREAT_MODEL.md) before changing account, content, or
request ownership behavior.

## License and citation

The framework and companion program code use Apache License 2.0; see [LICENSE](LICENSE)
and [NOTICE](NOTICE). The research directory separately licenses its derived data
and explanatory materials under CC BY 4.0; see its explicit license scopes.
Use [CITATION.cff](CITATION.cff) and record the exact source snapshot or commit
when citing the software. The companion manuscript remains a preprint preparation
and has no assigned public manuscript URL or DOI in this release.
