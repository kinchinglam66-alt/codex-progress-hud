# Independent Observation Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine whether an independent estimator can receive task-scoped events from existing Codex Desktop conversations without recurring main-model reports.

**Architecture:** Investigate the supported source boundary before implementing a provider. Produce a reproducible capability report that distinguishes existing-host observation, client-owned sessions, and cooperative fallback.

**Tech Stack:** Current Codex CLI documentation/help, existing TypeScript/MCP/Hook source, PowerShell read-only checks, Markdown evidence report. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-independent-estimator-design.md`

Status: plan prepared; tasks below have not been executed. This plan covers the first prerequisite only. The spec records subsequent delivery stages; their implementation details depend on this gate's result.

## Global Constraints

- No production-code, installed-plugin, global configuration, or cloud account changes in this phase.
- No paid inference, new Codex task, private transcript/database access, credential reuse, or attachment to undocumented host transports.
- Existing GUI observation and a client-owned App Server are distinct capabilities.
- Record missing capability honestly; main-model-generated reports do not count as independent source evidence.
- Project intent/private positioning documents stay outside public technical deliverables.
- Preserve the known-good cooperative tracking mode throughout the investigation.

---

## Task 1: Establish documented and installed capability boundaries

**Files:**
- Read: `src/mcp/main.ts`, `src/hooks/main.ts`, `src/hooks/schema.ts`, `src/server/http-server.ts`, `.mcp.json`, `hooks/hooks.json`.
- Create: `docs/superpowers/reports/2026-09-05-independent-observation-feasibility.md`.

**Interface:** Produce a capability table with columns `source`, `documented`, `available in installed host`, `identity`, `events`, `permission`, `evidence`, `limitation`. Availability values are `verified`, `unavailable`, or `unverified`.

- [ ] Read relevant official App Server/plugin documentation. Search specifically for supported attachment/subscription to an already-running Desktop host; do not infer it from App Server event names.
- [ ] Record installed CLI version and available App Server options using read-only commands:

```powershell
codex --version
codex app-server --help
```

- [ ] Inspect only the listed project files for currently supported observations and identity mappings. Use:

```powershell
rg -n 'threadId|turnId|task_handle|fallbackTaskHandle|sessionKey|turnKey|lease|hook' src/mcp/main.ts src/hooks/main.ts src/hooks/schema.ts src/server/http-server.ts
```

- [ ] Fill the table for Desktop subscription, client-owned App Server, optional Hooks, and cooperative MCP. Record exact source links and commands, without local credentials or raw identifiers.
- [ ] Mark unproven attachment claims `unverified`; absence from help alone does not prove unsupported functionality.

## Task 2: Verify the strongest available read-only observation route

**Files:**
- Update: `docs/superpowers/reports/2026-09-05-independent-observation-feasibility.md`.

**Interface:** Consume Task 1's capability table; produce scenario results with `pass`, `fail`, or `not_run`, plus provenance and reason.

- [ ] If Task 1 finds a documented, authorized Desktop subscription, use only that documented read-only interface against an in-scope conversation. Record observations of start/end, tool activity, plan updates, waits and task/turn identity as available. Do not trigger artificial paid work solely to manufacture evidence.
- [ ] Check two conversations only when their test scope is authorized. A single conversation cannot establish cross-conversation isolation; otherwise mark this scenario `not_run`.
- [ ] Confirm that any observed event arrives without invoking `progress_report`. Record whether source attachment observes old conversations, how reconnect identity works, and whether a turn-ending event contains a final status.
- [ ] If only a client-owned App Server route exists, record that capability without moving user execution into it. State that a custom client would be a separate product decision.
- [ ] If no documented Desktop route is found, record the gap and finish this phase. Do not replace it with filesystem polling, UI scraping, or a second model reading the same cooperative snapshot.

## Task 3: Close the gate and scope the next implementation

**Files:**
- Update: `docs/superpowers/reports/2026-09-05-independent-observation-feasibility.md`.
- Update: `docs/superpowers/specs/2026-09-05-independent-estimator-design.md` only to add the evidence-backed source decision.

**Interface:** Output exactly one of these product decisions, supported by the capability/scenario tables:

- `independent_gui_feasible`: existing GUI source verified with necessary task identity and fresh events; isolate untested cases before implementation.
- `cooperative_only`: useful estimation prototype possible, but data still depends on main-model reports; no zero-interference promise.
- `custom_client_required`: integration appears available only when owning the execution client; do not silently broaden the product.
- `insufficient_evidence`: attach route or permissions remain unknown; name the exact missing fact rather than starting provider implementation.

- [ ] Map each claim to a document, observed result, or clearly labeled inference. Avoid equating `turn/completed` with full-task completion.
- [ ] Verify that the plan's objective is answered, unavailable observations are not presented as passes, and no private project-positioning text appears in the report.
- [ ] Run `git diff --check` and inspect the scoped documentation diff. These are documentation/read-only deliverables; no unit tests or full-suite reruns are needed.
- [ ] Commit only the report/spec amendment after review. Do not push, publish, install, or add API credentials.
- [ ] Prepare the next scoped plan only from the selected source decision. For an independent route, proposed implementation boundaries are `src/observation/` (identity, allowlist, event contracts), `src/estimation/` (provider, scheduler, budget, stale-result guards), and `tests/observation/`, `tests/estimation/` plus an offline replay harness. These paths are proposed modules, not implemented capabilities.

## Later-stage acceptance requirements carried forward

Use a mock provider before real cloud inference. Test that slow/failed inference cannot block event ingestion or controls; budget reservations cap concurrent spend; stopped/replaced tasks reject late results; missing credentials or unknown prices produce no requests; source identities cannot cross-update tasks; model output cannot fabricate verified completion. Compare held-out prediction prefixes with local-only and cooperative baselines. Only then prepare optional shadow-mode deployment and provider setup.

## Self-review

The objective and tasks address the observation prerequisite only. No unsupported host API or provider/model identifier has been invented. Every investigation outcome has an explicit decision route. The later architecture remains conditional on that evidence; its cost and privacy controls are requirements, not settings enabled by writing this plan.
