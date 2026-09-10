# Turn-scoped lifecycle implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore round takeover and align ETA and outcome to the current execution turn.
**Architecture:** One coherent source-to-state-to-display change. Explicit local session lifecycle facts control clocks and terminal outcomes; model forecasts target only the current round. Missing prompt Hooks may be recovered from a verified already-attached local session, never from arbitrary remote identities.
**Tech Stack:** TypeScript, Node, Electron, Vitest.
**Spec:** docs/superpowers/specs/2026-09-10-turn-scoped-eta-and-outcome-design.md

## Global constraints

- No login, authorization, provider changes or real model calls.
- Preserve accounting, rate limits, memory bounds and terminal replay fences.
- Never equate quiet output or zero countdown with completion.
- Do not import other conversations. Earlier same-conversation context is background, not the ETA horizon.
- One implementation pass, one whole-change review and at most one bounded fix review, per user policy.

### Task 1: Round lifecycle end-to-end

Files: src/observer/{conversation-record,local-session-reader,context-owner,conversation-source}.ts,
src/server/{passive-goals,http-server,turn-router}.ts, src/estimation/{observer-scheduler,observer-contract}.ts,
src/estimation/assets/observer-instructions.md, src/ui/view-model.ts and focused corresponding tests.

Interfaces: preserve external Hook authentication; add an optional explicit normal-completion fact to local execution evidence (e.g. outcome: 'completed') instead of interpreting all waiting as completion. Preserve it during metadata compaction. Any persisted-turn takeover must originate from the validated local session source for an already-bound conversation, be chronological and idempotent, and use the same derived opaque identity as Hooks.

- [x] RED: add end-to-end regressions before implementation. Demonstrate normal completion, aborted/failed outcomes, new-turn reset, and missing-Hook takeover failures.

```ts
expect(goals.view(key, later)).toMatchObject({status:'completed',runtime:'waiting'});
// After accepted next-turn start, no elapsed/forecast from the previous turn:
expect(goals.view(key, nextStart)).toMatchObject({activeSeconds:0,prediction:null});
```

Run focused Vitest files with `--maxWorkers=1 --no-file-parallelism --reporter=dot` and capture expected failures.

- [x] Implement normal terminal provenance in reader/retention/selector. Match explicit event turn IDs; late unrelated terminal events cannot close a new turn. Generic Stop or waiting remains ambiguous until terminal provenance exists. Source reads must continue to observe later rounds in an attached conversation; completed-row pruning must not permanently prevent takeover.
- [x] Implement fresh per-turn state identity in PassiveGoals, including accepted late attachment, duplicate start idempotence, cleared summary/prediction/progress/pace scope and stale response rejection. Preserve session-level budgets.
- [x] Recover newer persisted task_started from verified attached session when prompt Hook is absent. Never use timestamps from untrusted tool text; fence older repeated records and file resets. A later Hook for the same source-discovered turn must not double reset state. User stop/pause/disable must not be undone automatically.
- [x] Change prompt/context semantics to current-turn horizon. Explicitly mark bounded older context as background. Update visible turn labels and completed filtering; no model completion claim may override actual live/terminal signals.
- [x] GREEN: test explicit completed signal without model; interruption vs tool errors; waiting/resume; next start with and without Hook; repeated start; old terminal/model result; source reset; two conversations; trim preserving terminal reason; no estimates after completion; retained accounting for in-flight calls. Update obsolete cross-turn-goal tests to the approved new contract, not weaker assertions.
- [x] Run typecheck and build, then full suite once at the milestone. Do not run real inference.
- [x] Self-review and report evidence; controller conducts the independent whole-change review. No push or installation during implementation.

## Local investigation evidence

The installed HUD remained attached to a finished prior turn while a new task_started was already persisted in the same session. Its observer had zero calls. The router only promotes unseen PostToolUse when there is no existing current turn, and the source selector intentionally stops at the old authenticated boundary. Simply lifting inference limits would not fix attachment ownership.

## Execution notes

Use branch fix/turn-scoped-lifecycle in the existing checkout (no changes to other worktrees). The change is tightly coupled and treated as one implementation/review unit. Keep private session contents and installation records out of public files.
