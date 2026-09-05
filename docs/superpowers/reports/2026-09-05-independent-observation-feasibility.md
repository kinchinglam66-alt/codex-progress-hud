# Independent observation feasibility: existing Desktop conversations

Date: 2026-09-05. Baseline: local `main`, `3034e53`.

## Decision

`insufficient_evidence`

No documented and locally verified passive attachment to the existing Desktop conversation was established. This is not a claim that attachment is impossible. The missing facts are the supported Desktop endpoint, its authorization/discovery contract, and whether an observer can receive scoped events without resuming or otherwise changing execution. Plugin Hooks are another candidate, but their execution and trust status in this host remain unverified.

Sequence: close this source investigation first; proceed next with Plan A's source-neutral local evaluation work; defer the live independent provider until a source and explicit provider setup are verified. A second model reading cooperative snapshots is possible but must not be advertised as independent observation.

## Evidence register

- E1: `codex --version` returned `codex-cli 0.153.3`, exit 0.
- E2: `codex app-server --help`, `codex app-server proxy --help`, `codex app-server daemon --help`, and `codex app-server daemon version --help` returned exit 0. The proxy accepts `--sock` and forwards to a running control socket. The daemon help describes local daemon management, including SSH-driven bootstrap. No daemon was started, restarted, or reconfigured; no socket was guessed or opened. Help presence does not identify the Desktop backend. These commands also printed a home-directory/PATH-alias warning; their successful help output is not a runtime connection test.
- E3: [Official App Server documentation](https://learn.chatgpt.com/docs/app-server), fetched on the report date. It documents transports and thread/turn/item events. `thread/read` does not resume or subscribe; resuming is not equivalent to a passive read. Runtime turn outcomes do not prove completion of a user's entire objective. This page did not establish an existing Desktop observer attachment procedure.
- E4: [Official Hooks documentation](https://learn.chatgpt.com/docs/hooks), fetched on the report date. Plugin enablement does not automatically trust Hooks: changed definitions require review. Background command Hooks are supported, but may finish out of order and be canceled at session end; `SessionEnd` remains synchronous. These are documented capabilities, not verified host behavior here. No trust bypass or trust-state write was attempted.
- E5: [Official remote connections documentation](https://learn.chatgpt.com/docs/remote-connections), fetched on the report date. It describes the app starting an App Server through SSH. This does not prove passive attachment to the current local GUI process.
- E6: Inspected `src/mcp/main.ts`, `src/hooks/main.ts`, `src/hooks/schema.ts`, relevant routes in `src/server/http-server.ts`, `.mcp.json`, and `hooks/hooks.json`. Findings below are local code inspection, not host-delivery tests.
- E7: Current installed plugin accepted handle-free `tracking_start` and `progress_report`, reporting `associationSource: mcp_lease`. `hud_status` returned `desiredState: on`, `observedState: running`. `hud_diagnose` returned `INTERNAL_ERROR`; no cause was established. These calls are cooperative tool activity, excluded from independent-event evidence. No raw task identifiers or diagnostic payloads are retained here.

## Capability matrix

| Source | Documented | Available in installed host | Identity | Events | Permission | Evidence | Limitation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Existing Desktop passive subscription | Attachment procedure not established | unverified | Required conversation + turn + source epoch; not observed | Not observed | Supported endpoint and observer authorization unknown | E2, E3, E5 | A public proxy command alone is not proof of GUI access |
| Client-owned App Server | Yes, protocol | unverified | Protocol thread/turn IDs | Lifecycle, item, plan, usage vocabulary | Explicit client connection and normal host authorization | E2, E3 | CLI help verified only; no client session launched; moving execution changes product scope |
| Plugin Hooks | Yes, subject to trust | unverified | Local adapter HMACs session ID and optional turn ID | Six configured lifecycle/activity categories | Enabled plugin plus reviewed current Hook definition and applicable host policy | E4, E6 | No fresh host-origin event demonstrated; trust status unknown |
| Cooperative MCP | Yes, existing project interface | verified | Opaque handle or MCP-process fallback | Explicit progress/outcome/validation/control reports | Installed tool and companion lease | E6, E7 | Main-model-dependent; shared-process fallback is not conversation isolation |

## Local architecture implications

The repository `.mcp.json` starts the Node MCP entry point. `src/mcp/main.ts` registers tools and a companion lease lifecycle; it does not subscribe to App Server events. The companion's `/api/events` SSE endpoint broadcasts HUD state, not a new Codex observation source.

The Hook adapter accepts a bounded input, emits an allowlisted envelope and uses a fail-open deadline. Its current envelope omits plan contents, token usage and tool durations; `PostToolUse` becomes generic activity. Optional turn identity cannot by itself guarantee ordering when absent. The configured Hooks have no `async` setting. Turning them asynchronous is not a mechanical change: context injection, event ordering and shutdown delivery need separate tests.

The current `hud_diagnose` failure is an unresolved release-quality issue, not proof that tracking failed or Hooks were unsupported. The successful status/report calls establish only companion/cooperative availability. Future diagnostics should expose bounded source provenance, last accepted Hook freshness and explicit unknown/unavailable distinctions without leaking identifiers.

## Scenario results

| Scenario | Result | Provenance / reason |
| --- | --- | --- |
| Installed CLI exposes App Server help | pass | E1, E2; no connection claim |
| Cooperative tracking and lifecycle status | pass | E7; reported running |
| Installed diagnostic command succeeds | fail | E7; INTERNAL_ERROR, cause unknown |
| Existing GUI events without model reports | not_run | No verified supported attachment or trusted Hook delivery path |
| Old conversation attaches mid-task independently | not_run | Cooperative start is not independent attachment |
| Two-conversation identity isolation | not_run | No independent source established; no other conversation exercised |
| Reconnect, loss recovery, waits and terminal events | not_run | No independent stream established |
| Client-owned App Server inference | not_run | Not needed for this gate; no paid or artificial task |

## Next scoped work

1. Inspect existing Plan A implementation/tests and define a source-neutral offline replay contract before changing runtime behavior. Preserve cooperative inputs and installed tracking.
2. Test deterministic active/wait timing, censored interruption samples, task-disjoint splits and absence of future-outcome leakage with synthetic traces. Compare the existing estimator against proposed changes on identical prefixes. Synthetic tests prove mechanics, not real-world ETA accuracy.
3. Independently investigate the bounded diagnostic failure and the supported Hook review/delivery path before asserting automatic tracking. Do not grant trust on the user's behalf, bypass policy or substitute private transcript polling.
4. Only after source verification, implement a mock-provider scheduler and test budgets, cancellation, task isolation and stale results. Real model choice, credentials, content sharing and paid inference remain separate setup gates.

No production source, installed package, trust settings, credentials, or cloud configuration changed in this investigation. No push or publication was performed. Review uses the scoped Markdown diff and `git diff --check`; a documentation-only change does not warrant rerunning the runtime suite.
