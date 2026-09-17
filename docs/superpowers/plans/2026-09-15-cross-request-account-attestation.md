# Cross-request account attestation implementation

**Goal:** Reuse successful account inspection for at most 30 seconds across normal context preparations, without sharing operation authority.

**Architecture:** A single memory-only identity-runtime cache returns original evidence and fresh one-use request handles after fresh local verification. Trusted worker code opts in; default and recovery/compaction paths bypass. Existing desktop serialization, prepared-input ownership, ledger and final guards remain.

**Tech Stack:** TypeScript, Node, Vitest, protected Windows observer home.

**Spec:** `docs/superpowers/specs/2026-09-15-cross-request-account-attestation-design.md` (written approval received).

**Global Constraints:** TTL 30,000 ms from full inspection START on wall and monotonic clocks; no renewal on hit. No credential content reading or serialization of cached authority. No installed changes, merge, push or model experiments in this implementation milestone. Preserve all existing uncommitted native work. One luna/high identity implementer, main owns integration/diagnostics, one sol/medium combined review and at most one fix review, per user policy. A cache pass does not satisfy native context or >=30% native preparation performance gates.

## Task 1: Identity cache and independent handles

Work in the existing `feat/persistent-eta-session` worktree. Write scope only: new `src/estimation/account-attestation-cache.ts`, `src/estimation/observer-identity-runtime.ts`, `tests/estimation/account-attestation-cache.test.ts`, `tests/estimation/observer-identity-runtime.test.ts`, and your report. Do not edit desktop, worker, scripts or their tests; main implements these concurrently. Do not commit existing dirty files or dispatch subagents.

Read the approved spec completely. Define/export the exact trusted-only interface in `account-attestation-cache.ts`:

```ts
export interface SessionPreparationPolicy { accountCache?: 'allow' | 'bypass' }
```

Change identity `prepareSession(signal, policy?: SessionPreparationPolicy)`; omitted or bypass means full check and no cache publication. Only allow normal session preparations publish/hit. Keep optional returned `reuse` interface unchanged.

- [x] RED: Add behavioral tests showing two allow preparations perform one full read, preserve original evidence timestamps and issue independent handles; omitted/bypass does full reads and does not publish. Run `D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/observer-identity-runtime.test.ts --maxWorkers=1 --no-file-parallelism` and record expected failures.
- [x] Implement single-entry immutable cache and generation fence. Store original time/metadata/binding/invocation privately. Reject clocks nonfinite/rollback/30-second boundary/original expiry; no sliding expiry. No global map or persistent cache.
- [x] Refactor same-strength local validation into a reusable guarded operation callable from cache prepare without self-pending deadlock. Preserve protected home checks, metadata equality, runtime integrity, owner closure, cancellation checks and final request proof guards.
- [x] Cache miss gets at most one full preparation. Local validation/full check failure, uncertain exit, account/route/assets/metadata change invalidate cache AND old handles. Setup, disable, close and explicit invalidation cancel preparations and fence in-flight publication. Same-account successful full check must not revoke other valid same-account handles. Early task abort before identity work must not invalidate another task's cache.
- [x] Cover invalidation during full read/local guard, metadata change, busy call, non-sliding TTL, check taking longer than TTL, clock rollback, close, cancellation, same-account replacement and independent handles. Use pure cache tests for clock boundaries plus existing mocked identity seams for integration. Do not weaken assertions or protection for fixtures.
- [x] GREEN focused identity/cache/request-handle tests. Self-review spec coverage and write full RED/GREEN evidence, files and concerns to `.superpowers/sdd/2026-09-15-cross-request-account-attestation/task-1-report.md`. Return only concise status and report path.

## Task 2: Trusted propagation and invalidation integration (main)

Files: `src/desktop/observer-runtime.ts`, `src/estimation/observer-persistent-worker.ts`, corresponding tests.

- [x] RED: Assert normal history and native context preparation pass `{accountCache:'allow'}`; observe fallback and explicit compaction pass `{accountCache:'bypass'}`; desktop forwards policy and revocation invalidates identity. Run focused tests and preserve failure evidence.
- [x] Import Task 1 interface in both modules and extend internal prepareSession signatures only. In worker ensure use `captureReuse ? 'allow' : 'bypass'`. Explicit direct compaction preparation bypasses. No HTTP/chat-controlled switch.
- [x] Preserve exact input/PID/binding ownership and final guard, no added inference retries or global model lock. On unconfirmed worker exit invalidate shared identity; ordinary release/cancel before identity does not clear shared cache. Ensure gate revocation/provider lifecycle cannot leave cache usable.
- [x] GREEN worker, desktop and concurrency tests; inspect call sites for unchanged API/nonpersistent behavior.

## Task 3: No-model measurement and fair native comparison (main)

Files: `scripts/diagnostics/account-reuse-preflight.mjs`, new `scripts/diagnostics/cross-request-account-preflight.mjs` if needed, `scripts/diagnostics/native-context-compare.mjs`, numeric metrics/tests as needed.

- [x] Force native/history structural comparison to bypass on BOTH routes irrespective of worker policy, and report that control. Do not reopen spent r9 or run new inference.
- [x] Add no-model diagnostic with fixed runtime/pilot constraints and exclusive output: allow cold preparation, allow warm preparation, explicit invalidation then allow preparation. Claim and final-validate each independent handle. Expect 3 preparations, 2 actual full reads, one warm hit, all cleanup confirmed. Keep original timestamps for warm hit and count actual reader events separately from prepare requests.
- [x] Report numeric/enumerated cache candidates/hits/miss reasons/local-guard counts and timing; no account labels, paths, secrets or reusable permissions in result. Test serializer privacy and bypass routing where feasible.
- [x] Run diagnostic once after focused tests/build and approved protected-home access, recording cold/warm elapsed and known limitations. No model tokens consumed.

## Task 4: Review and milestone verification

- [x] Main inspect integrated diff; generate scoped review artifact and dispatch one sol/medium reviewer for spec compliance plus auth/concurrency/ledger/code-quality risks. Address concrete findings in one fix pass and at most one fix review, per user limits.
- [x] Run typecheck, build and complete suite once at milestone (`D:/node.exe node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism`). Record exact final counts, errors, warnings and `git diff --check`.
- [x] Update cross-request report and native acceptance audit with measured benefit, remaining native-context failure and unpassed native gates. Do not claim overall goal complete, package/install or merge/push.

## Preflight consistency

Task 1 produces optional policy + unchanged return shape; Task 2 consumes same exported interface; Task 3 deliberately ignores allow in structural comparison. Task 1 and Task 2 have disjoint write sets. Tasks 2/3 share only prepareSession contract. Task 4 reads all; no conflicting writes. Tests assert explicit bypass rather than absence, matching code. Review count and no-commit/no-install constraints follow user scope over generic skill defaults.
