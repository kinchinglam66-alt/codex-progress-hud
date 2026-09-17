# Reusable Home Check Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, as requested by the user. No implementation subagents.

**Goal:** Reuse the local verification process without reusing verification results or weakening identity ownership.

**Architecture:** A bounded child transport owns lifecycle separately from request activity. A pinned helper repeats validation; one identity runtime owns its executor behind a default-off option.

**Tech Stack:** TypeScript, Node child_process, Windows PowerShell, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-16-reusable-home-check-design.md` (user confirmed).

## Global constraints

- Request timeout 10 seconds; idle retirement 30 seconds; cleanup bound 5 seconds.
- Request frame at most 256 UTF-8 bytes; response at most 4096 bytes.
- No cross-account/process-global pool. All existing checks repeat. No model/ledger/TTL changes.
- Candidate default off; no installation. Existing 85KiB and 1MiB gates remain mandatory.

## Task 1 — Bounded transport

Files: create `src/estimation/home-check-transport.ts`, `tests/estimation/home-check-transport.test.ts`.

Interface: `createHomeCheckTransport(invocation: Omit<Invocation,'input'>, expectedPath:string, options?: HomeCheckTransportOptions)` returns `check(verifyOnly:boolean, signal:AbortSignal):Promise<string>`, `retire():Promise<void>`, `close():Promise<void>`, `status()`.

- [ ] Write tests using controlled child streams. Two sequential `check(true, signal)` requests must each emit a distinct ID and only resolve after the corresponding response; a resident idle child remains owned but not checking.
- [ ] Run `D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/home-check-transport.test.ts`; confirm failure before implementation.
- [ ] Implement exact response schema/IDs, fatal UTF-8 decoding, bounded frames, stderr refusal, cancellation, deadline, idle retirement and close confirmation.
- [ ] Assert wrong IDs, malformed frames, unsolicited output and exit reject; unconfirmed cleanup poisons and forbids new spawn; an old-generation response never completes a new request.
- [ ] Run focused tests and `D:/node.exe node_modules/typescript/bin/tsc --noEmit`; fix only the failing scope.

## Task 2 — Pinned repeated-check helper

Files: modify `scripts/windows/observer-home.ps1`, `src/estimation/observer-home-assets.ts`; create `src/estimation/reusable-home-check.ts`; extend `tests/estimation/observer-home.test.ts` and asset tests.

- [ ] Add real Windows tests for two valid requests followed by changed ACL, config, missing path and invalid credential type. Verify-only does not create/repair.
- [ ] Run tests against the old script and observe rejection of persistent mode.
- [ ] Extract the existing checks into an explicit function; keep one-shot output/exit compatibility and add versioned fixed-operation protocol. No runtime source rewriting.
- [ ] Implement host wrapper repeating profile/path/hash/identity metadata checks for every transport request; refresh reviewed script pin and package expectations.
- [ ] Run Windows helper tests and packaging hash tests; retain script failures rather than relaxing ACL assertions.

## Task 3 — Identity-runtime integration

Files: modify `src/estimation/observer-identity-runtime.ts`; extend identity runtime and acceptance tests.

- [ ] Add failing tests for resident idle helper acceptance, cancellation cleanup, login/logout invalidation, identity binding changes and close failure.
- [ ] Add optional `reuseHomeCheckProcess?:boolean` default false. Both local guards and preparation use the runtime-owned executor when enabled. Successful request completion must not retire a healthy helper.
- [ ] Retire on invalidation; await real exit on runtime close. Keep existing one-shot path and authentication/cache semantics.
- [ ] Run focused runtime/guard/ownership tests and typecheck.

## Task 4 — Evaluation and review

Files: comparison diagnostics and `docs/superpowers/reports/2026-09-15-completed-turn-native-base.md`.

- [ ] Enable the candidate option equally on both routes in synthetic comparison tooling; leave installed route unchanged.
- [ ] Run zero-model real-host regression, then full suite/typecheck/build at milestone.
- [ ] Obtain one focused authentication/ownership review for this new scope; remediate findings before using results as release evidence.
- [ ] Run existing paired 85KiB evaluation; only proceed to required 1MiB evaluation when useful. Record preparation, first valid delivery, lifecycle and token accounting separately.
- [ ] Report all unmet gates. Do not merge, install or mark the overall objective complete without required evidence.

Commits are deferred to the validated milestone; preserve the existing dirty worktree and stage only explicitly reviewed files.
