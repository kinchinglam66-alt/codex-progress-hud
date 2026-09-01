# Codex Progress HUD Design

## Purpose

Codex Progress HUD is an open-source local companion for Codex. It presents task state, structured progress, estimated remaining time, and usage signals in a small always-on-top desktop window, while a packaged Codex plugin gives the executing model structured tools for progress and outcome reporting.

## MVP scope

- Windows-first Electron overlay with a frameless, always-on-top compact window.
- Local-only progress service bound to `127.0.0.1`.
- Structured task reports from a Codex MCP server: `progress_report`, `task_outcome`, and `task_status`.
- A reducer that also understands selected Codex App Server notifications so a future bridge can provide authoritative lifecycle events.
- ETA ranges derived from plan completion, elapsed time, model estimates, phase risk, and confidence.
- Server-sent events for live overlay updates.
- No telemetry, no cloud backend, and no raw prompt or command-output persistence.
- Apache-2.0 licensing and public-repository hygiene.

## Non-goals for the MVP

- Injecting controls into undocumented Codex native GUI surfaces.
- Scraping the Codex window or accessibility tree.
- Claiming that a completed turn proves the user's whole objective is complete.
- Publishing installers or creating the GitHub remote without the owner's repository choice.
- Automatic attachment to the private App Server instance used internally by the stock Codex desktop application.

## Architecture

```text
Codex skill ──calls──> MCP progress server ──HTTP──> local progress service
                                                        │
App Server event adapter ────────────────────────────────┤
                                                        ▼
                                            reducer + ETA estimator
                                                        │
                                                        ▼ SSE
                                             Electron overlay renderer
```

The local service is the single writer for current task state. The MCP process and future App Server bridge submit typed events. The reducer applies deterministic lifecycle precedence, and the ETA estimator returns a range and confidence instead of a false-precision countdown.

## State model

The public task states are `idle`, `running`, `waiting_approval`, `waiting_user`, `stalled_suspected`, `completed_unverified`, `succeeded_verified`, `failed`, and `interrupted`.

Explicit runtime failure or interruption outranks model reports. Waiting states do not count as active work. A model outcome can mark a task completed or blocked, but only validation evidence can promote it to `succeeded_verified`.

## ETA model

The estimator combines four signals:

1. Plan throughput from completed weighted steps and active elapsed time.
2. The executing model's structured remaining-time estimate.
3. Historical phase priors when enough local samples exist.
4. Risk multipliers for exploration, failed validation, stale activity, and scope change.

The MVP implements the first two signals and exposes the interfaces needed for historical priors. It reports `{lowSeconds, highSeconds, confidence}`. Waiting or terminal tasks return no active ETA.

## Local security and privacy

- Listen only on loopback.
- Authenticate mutating HTTP requests with a randomly generated local bearer token.
- Store the token in the user's application-data directory and never in the repository.
- Reject non-JSON and oversized request bodies.
- Do not enable permissive CORS.
- Keep raw prompts, reasoning, command output, access tokens, and file contents out of task records.
- Persist only opt-in aggregate timing samples in a later release.

## User experience

Compact mode shows task title, status, progress, ETA range, current step, and last-update age. Unknown progress uses an indeterminate treatment rather than a fabricated percentage. Waiting, suspected interruption, failure, and verified completion have distinct text labels in addition to color.

The MVP's Codex-side surface is the plugin and its tool results. A persistent native Codex sidebar remains a future host capability; the project must not rely on private DOM selectors or binary patching.

## Open-source boundaries

- Use Apache-2.0 for an explicit patent grant.
- State that the project is community-maintained and not affiliated with or endorsed by OpenAI.
- Treat “Codex” as a compatibility reference, not as the project's brand identity.
- Keep generated credentials, local event databases, build output, and user task data out of Git.
- Document the data flow, threat model, supported Codex versions, and experimental interfaces.
- Pin dependency resolution through `package-lock.json`; CI runs tests, type checking, build, and plugin validation.

## Acceptance criteria

- Core reducer tests cover explicit completion, failure, interruption, waiting, model progress, and stale detection.
- ETA tests cover plan-only, model-assisted, low-confidence, waiting, and terminal behavior.
- The local service accepts authenticated reports, rejects unauthenticated mutation, and streams snapshots.
- The Electron window renders the current snapshot and updates without reload.
- The plugin manifest validates and references a real MCP configuration and skill.
- Documentation makes privacy, security, trademark, and experimental-integration limits explicit.

