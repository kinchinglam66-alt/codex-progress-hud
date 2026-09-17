# Native owner reuse implementation plan

> Execute in the existing persistent-eta-session worktree with test-driven development.
> User approved the detailed design on 2026-09-15. No further design confirmation is needed.

**Goal:** Reduce full native context preparation by retaining a healthy per-conversation process while creating a fresh source fork for each ETA, without weakening integrity, accounting or cleanup.
**Architecture:** Trusted scheduler lifecycle permits control bounded idle retention; request sessions and custody leases remain separate within a process generation. Compression loss is diagnosed independently before any promotion.
**Tech Stack:** TypeScript, Node 22+, Vitest, pinned Codex 0.153.4 app-server, Windows process/file identity guards.
**Spec:** docs/superpowers/specs/2026-09-15-native-owner-reuse-design.md

## Global Constraints

- Preserve all existing unrelated and earlier uncommitted work. No main development, blanket commit, push, install or default promotion.
- Independent account only; synthetic inputs only in new experiments. No credentials, paths, history or account fingerprints in exported diagnostics.
- User granted continuing ETA/model/compaction test authorization without a total call-count ceiling on 2026-09-15. Do not request permission per batch. Keep independent-account synthetic inputs, durable per-operation accounting and independent experiment audits; old spent audits remain immutable. Each experiment retains its planned operation sequence and stops for diagnosis on failure. This is not a production-budget change. Do not fake process exit or drop unknown usage.
- Each conversation/source turn owns its process generation. Every ETA uses a new session, fresh fork, fresh request proof and fresh usage listeners.
- Retention: next ordinary eligibility + 60 seconds; clamp to 60..1860 seconds after true idle begins, using one monotonic clock. No ordinary poll extends this.
- Pause/wait/completion/new turn/account invalidation/disable/exit revoke retention. Recheck at acquire even if timer did not fire.
- At most 3 registered requests and snapshots per generation. At or above 64 MiB known owned bytes, or unverifiable identity/size, retire; third request terminal retires immediately.
- Preserve current snapshot source limit (at most 8 MiB), ACLs, persist-before-fork and exit-before-delete. Failed cleanup must block a new same-conversation generation and preserve recovery evidence.
- Focused tests during implementation, full suite only at stable milestone. One final sol/medium risk review, at most one fix review, as requested by user.
- Do not reopen r10 or merge diagnostic samples into formal performance results.

## Task 1: Trusted retention policy and scheduler propagation

Files: create src/estimation/native-owner-retention.ts and tests/estimation/native-owner-retention.test.ts; modify src/estimation/long-task-policy.ts, observer-scheduler.ts, src/desktop/observer-runtime.ts and their focused tests.

Define internal NativeRetentionPermit {conversationKey:string; turnKey:string; generation:number; idleStartedAtMs:number; deadlineMs:number}, and NativeRetentionState {conversationKey:string;turnKey:string;generation:number;running:boolean}. Times are monotonic milliseconds.
Export ordinaryRequestIntervalSeconds(remaining:number|null,unknown:number) from the existing policy, preserving all values.
Pure createNativeRetentionPermit(input including state, idleStartedAtMs, nextOrdinaryAtMs) returns frozen permit or null on malformed/non-running input; deadline = min(idle+1860000,max(idle+60000,next+60000)).
Pure nativeRetentionValid(permit,state,nowMs) requires exact key/turn/generation, running and finite clock between idle start inclusive and deadline exclusive.
Add optional worker.updateRetentionState(state|null):void and release(permit?:NativeRetentionPermit|null):Promise<void>; workerSource forwards state to an existing delegate only and optional release permit. No HTTP/user control.
Scheduler gets optional monotonicNow default performance.now. At real accepted request completion, derive next regular eligibility from existing active-time coordinates and current ordinary interval, not an event shortcut. Generate one permit after settlement; send null for failed/stale/unaccepted requests. Forward state at changed/tick (including absent state) and invalidate on stop. No model calls added.

RED: add literal cases deadlines at 360000/660000/960000/1860000 for idle=0 and eligibility=300000/600000/900000/1800000; invalid clocks, deadline boundary, stale generation, waiting state. Scheduler integration must show waiting update reaches retained idle worker and regular polling does not mint a new release permit.
Run: D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/native-owner-retention.test.ts tests/estimation/observer-scheduler.test.ts tests/estimation/long-task-policy.test.ts tests/desktop/observer-runtime.test.ts --maxWorkers=1 --no-file-parallelism
GREEN: implement only internal policy/forwarding, preserve trigger decisions. These APIs do not themselves retain a process; Task 3 is the consumer.

## Task 2: Multi-request native custody resources (bounded sidecar)

Files: src/estimation/native-worker-resources.ts, tests/estimation/native-worker-resources.test.ts; create src/estimation/native-resource-usage.ts and tests/estimation/native-resource-usage.test.ts only if a focused measurement helper is required. Main owns observer-persistent-worker.ts interface edits.
Keep destination/claim/release signatures; add optional usage():Promise<{requests:number;knownBytes:number}> to NativeWorkerResources. Throws on unverifiable owned file identity/size. Existing fakes may omit it; absence prevents production retention.
Replace singleton lease state with independent records. destination may allocate a new record only after previous copy/claim settled, at most 3 outstanding records. claim matches exact registered snapshot, never latest mutable singleton. Retain all records until generation release.
Each record keeps copy completion, snapshot custody, fork custody intent/tag and registered fork identity. Keep old v1 persistent manifests compatible; prefer no format change. Persist intent before fork RPC. No cleanup until PID/birth exit proven.
usage measures only known owned snapshot/manifest/fork-log files using identity-safe reads. Discover owned fork log only within independent runtime home and with exact custody tag; do not scan real main history. Cache discovered paths with identities, verify again before reuse. Unknown/missing/replaced files fail closed. Source files are never included or mutated.
release drains all copy promises, cleans all dead-owner forks once, then all snapshot leases. Failure retains every still-needed reference; repeat release can finish safely. afterProcessClosed callbacks must be safe for multiple leases; do not spawn a cleanup process per fork unnecessarily. Live peers remain untouched.
RED: real temporary files + controlled process/RPC boundary: two successive snapshots/forks accepted and both remain while child alive; release rejected while alive and succeeds after proven exit; half-copy failure/retry cleanup; third allowed/fourth rejected; replaced owned file rejected by usage; v1 recovery preserved.
Run: D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/native-worker-resources.test.ts tests/estimation/native-snapshot-custody.test.ts tests/estimation/native-fork-custody.test.ts tests/estimation/native-resource-usage.test.ts --maxWorkers=1 --no-file-parallelism
GREEN: minimal multi-record lifecycle, no weakening of ACL or ownership probes. Report exact RED/GREEN evidence, changed files and unresolved risks. No commit, no other agents, no model calls.

## Task 3: Separate process lifetime from request session lifetime

Files: src/estimation/observer-persistent-worker.ts, observer-persistent-session.ts if needed for explicit listener disposal; tests/estimation/observer-persistent-worker.test.ts and observer-persistent-session.test.ts.
Consume Task 1 permits/states and Task 2 usage. Add optional monotonicNow and timer injection only as normal production lifecycle dependencies (default performance.now/setTimeout).
Retain owner/RPC only after a healthy terminal and successful ledger settlement with a valid current permit and verified resource limits. Release invalidates one-use preparation authority regardless of retention.
Before new destination/prepare, serialize against retirement; check expiry/status/turn/account binding and request/byte thresholds. Same owner creates a new session/fork, initializes RPC only once; remove old session notification listeners, goal state and counters.
Track each snapshot and afterProcessClosed callback until confirmed retirement. reset revokes timer/permit synchronously, closes owner, writes actual exit once, batch-cleans resources, then drops references. Failure keeps recovery evidence and forbids new owner.
State updates never slide idle deadline. Old timer cannot retire a newly acquired request. Active calls are cancelled by existing state handling, never killed merely by idle expiry. Third terminal forces retirement.
RED: same PID but distinct fork IDs for same-turn second ETA; no processExit while warm; independent source/account/turn retires; 5/10/15/30 minute reuse, boundary expiry, clock reversal, stale timer, third-request retirement, byte limit, usage failure, cleanup failure and idle state revocation. Test real worker/session with external RPC/process doubles only.
Run: D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/observer-persistent-worker.test.ts tests/estimation/observer-persistent-session.test.ts tests/estimation/observer-account-reuse-concurrency.test.ts tests/estimation/native-worker-resources.test.ts --maxWorkers=1 --no-file-parallelism
GREEN: preserve history-route behavior, accounting proof rules and no global concurrency cap.

## Task 4: Pinned-runtime no-inference lifecycle verification

Files: scripts/diagnostics/native-owner-lifecycle.mjs, focused harness contract tests if reusable code is extracted, docs/superpowers/reports/2026-09-15-native-owner-reuse.md.
First add a harness test rejecting model-operation RPC methods; exercise lifecycle orchestration with a controlled local runtime boundary, then implement.
Use fixed synthetic source in independent home, at most 3 forks; initialize/fork/goal-clear/goal-read/delete only, never turn/start or compression. Capture same process identity across forks, source digests, registered resource counts and final cleanup.
Run pinned runtime only after focused tests/build. Preserve raw local evidence, failures and recovery manifests. No inferred clean exit. Stop on failure, fix based on evidence before paid tests.

## Task 5: Compression boundary localization

Files: scripts/diagnostics/native-compression-localize.mjs plus src/evaluation native checkpoint/authority helpers and focused tests only as needed.
New exclusive audit, never r10: at most 3 ETA and 1 compaction, luna/medium/standard, no real history. First establish tests for exact same-checkpoint identity and excluding probe answers; observe RED before implementation.
Run raw fork A probe; separate identical-source fork B compaction then same-branch probe; import that exact pre-probe checkpoint + pre-fixed source tail into independent fork C and probe. A/B outputs cannot enter C source.
Stop on failed fact retrieval or unconfirmed operation; completed unknown compaction usage remains recorded. Automatic replacement checkpoint invalidates trial. Report which boundary failed, not speculation about encrypted contents.
Build and run focused evaluation tests before one bounded diagnostic. No blind repeats.

## Task 6: Acceptance, risk review and candidate decision

Use existing native-context comparison harness only after lifecycle/localization pass. New bounded audit <=6 ETA +6 necessary compactions, 3 distinct checkpoints, alternating route order, same account-cache policy (structural bypass both).
Measure complete prep and first-valid-delivery, cleanup, peak owned bytes, cold/warm and actual cadence evidence; never alter trigger frequency for a warm hit.
Need all integrity/isolation checks and 3 valid pairs, median prep >=30% improvement, no worse median delivery or unexplained tokens/warm degradation. Diagnose any failure instead of repeated trials.
At stable implementation run npm test -- --run --maxWorkers=1 --no-file-parallelism; npm run typecheck; npm run build. One final gpt-5.6-sol/medium review of new lifecycle/accounting/authorization slice, at most one fix review.
Document evidence and remaining gaps. Prepare candidate only if all gates pass; do not install or promote default without the separately required disabled-plugin state.
