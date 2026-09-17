# Request-scoped Account Attestation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove a duplicate full account inspection inside one prepared ETA request without weakening per-call authorization, ownership, or accounting.

**Architecture:** The identity runtime issues a memory-only one-use handle after stable before/after independent-file metadata checks. The desktop wraps it in its existing serialized consent/binding boundary; the worker attaches it to the exact prepared input and validates again immediately before dispatch. Missing or invalid handles use the existing full preparation before admission only.

**Tech Stack:** TypeScript, Node filesystem metadata, Vitest, owned app-server subprocesses.

**Spec:** `docs/superpowers/specs/2026-09-15-request-scoped-account-attestation-design.md`

## Global Constraints

- 上限为原检查开始后 30,000 毫秒，且不得超过原账户证据有效期。命中、排队或后续验证均不续期。
- No cross-request/turn/conversation/process reuse; no serialized capability or credential-content read.
- Preserve exact release hashes, protected independent home, original evidence expiry, authorization, separate ETA/compaction admissions and unknown usage.
- Any preparation compaction invalidates the ETA handle. Account notifications invalidate, never authorize.
- After admission an invalid proof cancels the unsent reservation; no second admission, model retry, or hidden account switch.
- Apply equally to native and historical paths; existing native cleanup, context-reliability and fair performance gates remain independent.
- No merge/push/install, real-history transfer, main credential access, or audit deletion. Synthetic calls remain bounded and audited.

## File responsibilities and internal interfaces

New `src/estimation/session-account-reuse.ts` owns time/one-use/invalidation; `observer-identity-files.ts` owns metadata only. `observer-identity-runtime.ts` supplies guarded issuance after full inspection. `desktop/observer-runtime.ts` preserves serialized metadata and exact binding. `observer-persistent-worker.ts` owns request/process/source and dispatch fences. Keep existing process cleanup and API routes unchanged.

```ts
export interface SessionAccountProof {
  validate(signal: AbortSignal): Promise<boolean>;
  valid(): boolean; // synchronous final clock/generation guard after async local checks
}
export interface SessionAccountReuse {
  claim(signal: AbortSignal): Promise<SessionAccountProof | null>;
  invalidate(): void;
}
// Prepared identity/desktop session results gain reuse?: SessionAccountReuse.
// PersistentWorkerOptions gains invalidateSessionReuse?: () => void.
export function createSessionAccountReuseIssuer(options: {
  now: () => number; monotonicNow: () => number;
}): {
  issue(input: {observedAt: number; observedMonotonic: number; expiresAt: number;
    validateLocal: (signal: AbortSignal) => Promise<boolean>}): SessionAccountReuse;
  invalidate(): void;
};
export function captureObserverIdentityFiles(authHome: string): Promise<string | null>;
```

The metadata result is private opaque comparison material, never a diagnostic field. Require canonical non-symlink directory identity, a regular single-link auth.json with stable file identity and timestamps. Also track config.toml presence/absence and metadata; absence is permitted only for config because the trusted home profile intentionally omits it. Re-stat around canonical resolution; fail closed to no reuse on uncertainty. Existing home checks continue to reject unexpected config and verify ACLs.

### Task 1: Identity issuer and local metadata validation

**Files:** Create the two modules above and matching `tests/estimation/session-account-reuse.test.ts`, `observer-identity-files.test.ts`; modify `observer-identity-runtime.ts` and its test.

**Interfaces:** Produces the exact interfaces above and optional `reuse` on `prepareSession`, plus `invalidateSessionReuse()` on the runtime. Consumers never inspect identity metadata or extend deadlines.

- [ ] RED: Add clock, one-use, cancellation, asynchronous invalidation, file replacement/write/hardlink/missing and runtime local-revalidation tests. Actual issuer example:
  ```ts
  let wall=1000, mono=20;
  const issuer=createSessionAccountReuseIssuer({now:()=>wall,monotonicNow:()=>mono});
  const reuse=issuer.issue({observedAt:1000,observedMonotonic:20,expiresAt:301000,validateLocal:async()=>true});
  const proof=await reuse.claim(new AbortController().signal);
  expect(proof?.valid()).toBe(true);
  expect(await reuse.claim(new AbortController().signal)).toBeNull();
  wall=31000; mono=30020;
  expect(proof?.valid()).toBe(false);
  ```
- [ ] Run `D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/session-account-reuse.test.ts tests/estimation/observer-identity-files.test.ts tests/estimation/observer-identity-runtime.test.ts --maxWorkers=1 --no-file-parallelism`; record RED before implementation.
- [ ] GREEN: Implement closure-owned consumed/dead flags and issuer generation. Claim sets consumed synchronously before await. Valid rejects nonfinite clocks, rollback since start/last validation, elapsed >=30000 or original expiry. Validate checks before and after local guard; failure permanently invalidates.
  ```ts
  if(consumed) return null;
  consumed=true;
  if(!valid() || signal.aborted) return null;
  if(!await validateLocal(signal) || !valid() || signal.aborted) { dead=true; return null; }
  return proof;
  ```
- [ ] Runtime: capture original monotonic/wall clocks before full inspection; capture metadata before/after account read. Only stable non-null metadata can issue. The guard owns a fresh home manager and runner, performs home.prepare(false), pinned runtime-cache check, home.prepare(true), metadata equality; require stable assets/version, idle ownership and active runtime. Serialize against identity operations; cancellation/cleanup uncertainty invalidates. Login/logout/disable and observed-account invalidation revoke issuer generation. No new account read on hit.
- [ ] GREEN and self-review: run the focused command, report individual RED/GREEN evidence and any unsupported metadata platform fallback. Keep work uncommitted until integrated milestone to preserve existing dirty code.

### Task 2: Desktop authority and worker request-to-dispatch fences

**Files:** Modify `src/desktop/observer-runtime.ts`, `src/estimation/observer-persistent-worker.ts`, `tests/desktop/observer-runtime.test.ts`, `tests/estimation/observer-persistent-worker.test.ts`.

**Interfaces:** Consume `SessionAccountReuse/Proof` from Task 1; optional contract keeps existing providers/fakes compatible. Desktop passes optional `reuse` and `invalidateSessionReuse`. No HTTP payload field.

- [ ] RED: Extend existing actual local-child fixture with issuer-backed handles and controlled clocks; assert one full prepare and one accounted ETA, clone rejection, stale/release/process/turn fences, event invalidation, compaction and final-expiry settlement.
  ```ts
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.fullChecks()).toBe(1);
  expect(f.accounting.snapshot()).toMatchObject({starts:1,knownTokens:110,unresolved:0});
  ```
- [ ] Run worker/desktop focused tests and record failure from duplicate preparation or missing dispatch guard.
- [ ] GREEN desktop: wrap claim/validate with `serial(metadataTail, ...)`, original `check(signal)`, `gate.update(originalEvidence)` and exact authorized binding. Never refresh the original evidence timestamps. `valid()` checks current gate and proof; invalidate delegates to identity. Propagate `identity.invalidateSessionReuse` to workers for account notifications.
- [ ] GREEN worker: enrich prepared-owner WeakMap with key/generation/source epoch/request UUID/PID-birth/binding and optional handle. New prepare/release/reset invalidates prior prepared handle. Claim once before await; require current exact owner before reuse. A hit uses the existing session only. Miss performs one old full ensure and preserves stale-input handling. Compaction clears eligibility before its own full inspection.
  ```ts
  const proof=preparedOwner && matchesOwner(preparedOwner)
    ? await preparedOwner.reuse?.claim(combined) : undefined;
  const live=proof ? session! : await ensure(combined);
  // After attachment checks, reserve, journal and updateInvocation:
  if(proof && (!await proof.validate(combined) || !proof.valid()))
    throw Error('ACCOUNT_REUSE_INVALID_BEFORE_DISPATCH');
  check(combined);
  if(!matchesOwner(preparedOwner)) throw Error('SOURCE_PREPARATION_STALE');
  ```
  Use a non-SESSION_ error code for pre-dispatch failure so the existing catch does not bypass cancelBeforeDispatch. Persist cancelled_before_dispatch terminal where operationStarted exists, then old reset and reservation cancellation; no model call or retry.
- [ ] Subscribe once per opened RPC to account/updated; invalidate local handle and identity issuer, remove listener on reset/close even if cleanup fails. Do not retain notification bodies. Check process liveness and source owner again after every async final proof validation.
- [ ] Run focused tests; add table cases for expires during journal/admission, signal abort during guard, post-dispatch actual known/unknown settlement and no leaked subscription. Record GREEN.

### Task 3: Local no-inference validation and targeted review

**Files:** Create `scripts/diagnostics/account-reuse-preflight.mjs`; report `docs/superpowers/reports/2026-09-15-request-scoped-account-attestation.md`. Modify native comparison harness only to pass the same new internal contract to both paths.

- [ ] Build a no-model diagnostic using production independent identity + environment resolver and unchanged pilot configuration. Run a full prepare, claim and final validate; never call turn/start, compact, login or credentials APIs. Emit only stage counts and elapsed times.
  ```ts
  const first=await identity.prepareSession(signal);
  const proof=await first.reuse?.claim(signal);
  const valid=proof ? await proof.validate(signal) && proof.valid() : false;
  // Report {fullChecks, reused:valid, elapsedMs}; close in finally.
  ```
- [ ] Add bounded fixture validation of no second account-reader spawn, actual local guards, metadata mutation miss and no model methods. Record no-inference timing separately from ETA improvement.
- [ ] Request one new targeted `gpt-5.6-sol / medium` review of this new authorization/identity/accounting boundary with spec, changed paths and test evidence. At most one fix review. No repeat of old native architecture review.
- [ ] Full milestone: `D:/node.exe node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism`, `D:/npm.ps1 run typecheck`, `D:/npm.ps1 run build`, diagnostic syntax checks and `git diff --check`. Use required elevated permissions for protected local test fixtures; never weaken ACL checks.

### Task 4: Bounded synthetic evidence, independent native gate

**Files:** `src/evaluation/native-trial-authority.ts`, `src/estimation/native-trial-budget.ts`, associated authority tests, existing comparison report.

- [ ] Only after local and review gates pass, create a new fixed r9 audit identity; leave all r1-r8 files/records untouched. Test exclusive acquisition and old-authority rejection before live use.
- [ ] Run the existing approved synthetic comparison with the same reuse contract on both paths; retain failure stop, separate compaction accounting, cleanup receipts and marker validation.
- [ ] Report actual full-inspection count, guard cost, delivery time, token/unknowns and marker coverage. Three validated pairs, warm/new-turn and 30% original gates are still required; a failure is diagnostic evidence, not a release. No real history, installation or default promotion.

## Self-review / execution ledger

Spec coverage: Tasks 1/2 cover sections 5-7 and the full negative matrix; Task 3 covers real local boundary and new focused review; Task 4 preserves section 1/8 native independence. Interfaces above are shared verbatim. No new file-content credential reads. Current worktree is already isolated on feat/persistent-eta-session; baseline before these changes is 219 files / 2657 passing tests. Existing native changes and private scratch files are preserved.

Execution choice: tightly coupled worker/desktop integration stays with the main agent; a bounded identity/metadata implementation can run as a sidecar under the approved agent routing. One targeted final review per user policy supersedes repeated task-review loops. No new user confirmation needed for the already approved implementation.

Progress 2026-09-15 11:26 local: Task 2 implementation and focused tests are green (60 worker / 29 desktop tests); final integration and review remain open. Task 1 identity sidecar is still completing local ownership/metadata checks. Task 3 no-inference diagnostic script added and syntax-checked, not yet executed. Task 4 not started; no additional model usage.

Progress 2026-09-15 11:54 local (supersedes prior progress):

- Task 1: implemented, focused tests green, targeted review and its one scoped fix review cleared. Stable peer issuance no longer revokes other same-account requests.
- Task 2: implemented, 61 worker and 29 desktop tests green; real shared-runtime/two-worker race coverage added in the fix round.
- Task 3: no-inference production preflight passed (one full check, 5.279 s preparation + 1.060 s claim + 1.095 s final guard), typecheck/build passed, pre-fix full suite 221 files / 2679 tests passed. Post-fix full suite remains running; no release claim.
- Task 4: not started. R8 is spent; r9 has not been enabled or executed. No live HUD ETA/compaction calls during this implementation; no real history sent, no install/merge/push. Both subagents have been closed after the approved review sequence.

Terminal progress 2026-09-15 (supersedes prior progress and unchecked execution templates):

- Tasks 1–3: complete for this account-reuse boundary. Post-fix full suite passed 222 files / 2682 tests (367.84 s, exit 0); targeted review and one fix review cleared; typecheck/build and no-model production preflight passed.
- Task 4: bounded r9 executed and stopped on second-checkpoint native context evidence. One validated pair; three ETA calls, one completed synthetic compaction, 40,223 known tokens and one unknown usage record. All cleanup confirmed. Diagnostic authority update after the full suite passed its own 2-file / 8-test focused check plus typecheck/build.
- First paired preparation: history 8.264 s versus native 10.283 s; full delivery 19.209 s versus 23.117 s. No native performance acceptance, warm/new-turn conclusion or ETA-accuracy claim.
- Remaining measurement gap: r9 lacks per-sample full-reader/reuse counts; preflight count is not extrapolated to the live trial. Native context and performance acceptance remain pending. R9 is spent, no blind retry, real-history transfer, merge, push, installation or default promotion.

Follow-up diagnostic progress: added prepareSession/reuse/guard counters and elapsed measurements to both comparison strategies; they do not count reader retries or change authorization semantics. A second no-model production preflight verified one prepare, one claim/hit, one passed final guard, 4.554 s full preparation plus 2.049 s local guards, cleanup confirmed. Diagnostic-focused verification: 6 files / 62 tests, typecheck/build and syntax/diff checks passed. This fills instrumentation for future evidence, not historical r9 measurements. Native context retrieval and end-to-end latency gates remain open.
