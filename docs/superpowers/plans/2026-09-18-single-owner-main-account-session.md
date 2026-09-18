# Single-owner main-account session implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. User chose inline implementation in the existing isolated worktree and authorized design changes without repeated approval.

**Goal:** Authenticate and prepare a cold main-account ETA using one worker-owned process rather than two.

**Architecture:** The worker supplies a request-scoped transport opener to identity preparation. Metadata attestation uses that initialized transport and returns its identity; the desktop wrapper forwards it only after consent checks, and the worker validates the exact attested transport before importing context.

**Tech Stack:** TypeScript, Node.js child processes, pinned Codex app-server JSON RPC, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-single-owner-main-account-session.md`

## Global constraints

- Preserve complete effective conversation context, the 30-second ETA deadline, account-change fencing, consent, usage accounting and confirmed cleanup.
- No cross-request main-account cache.
- No thread/turn/history operation occurs until metadata, consent and durable owner receipt pass.
- Independent account behavior remains unchanged.
- Preserve private history and credentials outside source control.

## Task 1: Shared transport contract and metadata reader

Files: create `src/estimation/main-account-session-transport.ts`; modify `src/estimation/main-account-metadata.ts`; extend `tests/estimation/main-account-metadata.test.ts`.

Contract:

```ts
import type {Invocation} from './owned-process.js';
import type {createObserverSessionProcess} from './observer-session-process.js';
import type {createMainAccountLease} from './main-account-lease.js';
export type MainAccountSessionTransport = Awaited<ReturnType<ReturnType<typeof createObserverSessionProcess>['start']>> & {
  invocation: Invocation;
  lease: ReturnType<typeof createMainAccountLease>;
};
export type OpenMainAccountSession = (invocation:Invocation, signal:AbortSignal)=>Promise<MainAccountSessionTransport>;
```

- [ ] Extend the existing real child-process test script to count `initialize`, `account/login/start`, `account/rateLimits/read`, and reject thread/turn calls during metadata inspection. Open and initialize an owner in the callback, return its transport/lease, then assert metadata returns the same transport while the owner stays alive until explicit worker-side close. The reader must not start its own process.
- [ ] Run `npx vitest run tests/estimation/main-account-metadata.test.ts --maxWorkers=1 --no-file-parallelism`; confirm the new borrowed-transport case fails because the reader does not support the opener.
- [ ] Add optional opener to reader options and transport to its result. Keep standalone read behavior; borrowed branch validates invocation and fingerprint, uses the supplied initialized RPC/lease, authenticates once, and leaves successful cleanup to owner. Failed borrowed read closes RPC and propagates failure for owner cleanup.
- [ ] Cover mismatching transport, route mutation and cancellation; keep existing standalone cleanup assertions. Run focused reader/auth/lease tests and typecheck.

## Task 2: Identity, consent wrapper and persistent owner wiring

Files: modify `src/estimation/account-attestation-cache.ts`, `src/estimation/observer-identity-runtime.ts`, `src/desktop/observer-runtime.ts`, `src/estimation/observer-persistent-worker.ts`; tests in `tests/estimation/observer-identity-runtime.test.ts`, `tests/desktop/observer-runtime.test.ts`, `tests/estimation/observer-persistent-worker.test.ts`.

Interfaces: add optional `openMainAccountSession?: OpenMainAccountSession` to preparation policy and `mainAccountSession?: MainAccountSessionTransport` to prepared identity and worker results. Re-export no credentials. Cross-request cache does not store this transport.

- [ ] Add failing integration cases that count preparation/start/auth calls: first cold request uses one worker-owned child and one remote account validation; subsequent cold request gets fresh transport; standalone settings and independent provider remain close-on-return.
- [ ] Identity passes opener only in main-account session mode, returns only the reader's attested transport, and preserves custody/reuse guards. Desktop wrapper forwards it only after authorization and binding checks; denial must leave the worker responsible for resetting its already-owned process.
- [ ] Extract worker process opening and notification subscription from `ensure` into one local helper reused by the ordinary and shared paths. The helper records owner/lease references before awaits, initializes once, and never authenticates or imports on its own. Shared path calls it through the policy opener and authenticates in the metadata reader; ordinary path retains its current authentication call.
- [ ] After prepareSession, require `prepared.mainAccountSession === openedTransport`, matching invocation/process/account identity and live lease. Journal the owned process before import. Reject partial/missing/mismatched adoption without silently creating another child. Reset unhealthy previous owners before offering a new transport.
- [ ] Test cancellation at each await, account/consent/source change, receipt failure, unexpected work and close failure; assert no model request and confirmed cleanup or poison. Run focused identity/desktop/worker/auth/lease suites.

## Task 3: Review, release evidence and installed timing

- [ ] Run one Sol/medium readonly review of ownership, authentication and accounting boundaries; fix blocking findings, at most one fix review.
- [ ] Freeze source/tests; run `npx vitest run --maxWorkers=1 --no-file-parallelism` with normal filesystem permissions. Await the same live handle to terminal completion.
- [ ] Run fresh typecheck/build and HTTP smoke. Commit only explicit implementation/tests/generic docs; exclude private notes and unrelated untracked reports.
- [ ] Build candidate using existing `.superpowers/sdd/build-persistent-install.mjs`; verify compiled files, assets and packaged smoke. Install only while plugin is disabled and processes are absent using the existing hash-checking installer. Preserve account, proxy, consent and ledgers.
- [ ] Observe installed real first-result timing and a subsequent turn. Record all stages, usage completeness and trigger wait. Any timeout or total over30s remains a failed latency requirement, not a successful deadline guard. Continue root-cause work as required.

## Self-review

### Implementation verification checkpoint

Shared transport is implemented through the real metadata reader, identity runtime,
desktop consent wrapper and persistent worker. Local child-process integration covers
initial adoption, healthy retention, a subsequent cold owner, post-attestation consent
revocation, mismatched attestation, account/route drift, cancellation, receipt failure,
unexpected-work accounting and failed process closure. The latter uncovered and fixed
missing `cleanupPending` for non-native main-account owners; no false exit confirmation
is permitted. Standalone metadata and independent-provider paths remain unchanged.

The focused cross-layer matrix has 12 passing cases. An initial full regression passed
3,400 tests before the final cleanup-status correction. Independent fix review approved
the revised implementation subject to fresh full regression. Release packaging and
installed latency measurements are separate gates; local tests do not establish that
real end-to-end ETA latency is below 30 seconds.

Final regression after the correction: 276 files / 3,403 tests passed. Fresh TypeScript,
build and protocol/event/shutdown smoke passed; the independent fix review found no
remaining actionable issues. Installed timing remains to be measured.

The plan separates metadata from model work and does not remove a remote identity check from the process that runs inference. Transport lifetime is worker-owned before callback use, eliminating an unclaimed-owner gap. Cancellation/cleanup and retained-owner paths require tests before installation. This plan does not assert that saving one handshake is sufficient for every network/model response to finish under30s.
