# Full Conversation Estimation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supply every readable conversation record to mid-task ETA observations, compressing earlier history only when provider capacity requires it.

**Architecture:** Separate a source-backed history snapshot from the small lifecycle projection. Prepare the snapshot asynchronously against trusted model/request capacity, optionally using an accounted read-only compression call, then send one validated input without secondary clipping. Fence reading, compression and prediction to the same conversation, source epoch, turn and provider generation.

**Tech Stack:** Existing Windows/Electron/TypeScript application, Node file handles, Zod, Vitest, existing subscription and Responses transports. No new tokenizer dependency without checking runtime compatibility.

**Spec:** `docs/superpowers/specs/2026-09-12-full-conversation-estimation-design.md` (approved by user).

## Global Constraints

- "The prediction horizon remains the remaining active work of the authenticated current turn, not the entire project."
- "Do not apply privacy redaction or credential-pattern filtering to task text in this mode."
- "Only model/request capacity overflow permits automatic compression of older text."
- "Do not add persistent copies of raw conversations for this feature; use the existing source and bounded, discardable in-memory caches."
- "Unknown usage remains unknown; do not treat it as zero."
- "Removing input redaction does not remove diagnostics/logging privacy restrictions."
- Never import the plugin's own credentials/configuration, arbitrary referenced files, unrelated conversations or hidden reasoning into task context.
- Preserve existing terminal-signal, restart-recovery and active-clock contracts. Historical text is not historical active-time evidence.
- No silent fallback to the 128-message/4096-character/16–64-KiB packet selection or the 256-KiB history eviction.
- Do not merge, push, install or run paid probes in this implementation phase without the relevant user instruction.

## Execution and review discipline

Create `feat/full-conversation-estimation` in an isolated worktree using the worktree skill; do not modify other worktrees. Run focused tests for each task and one full suite at the integration milestone. User policy overrides repeated per-task agent review: one consolidated review, at most one fix review. Routine implementation/tests use explicitly selected `gpt-5.6-luna` / `medium`; source/concurrency/provider changes use `gpt-5.6-luna` / `high`; final accounting/security/architecture review uses `gpt-5.6-sol` / `medium`. No progress for 30 minutes requires a status report, not repeated polling.

Tasks 1–2 establish interfaces. After those land, Task 3 and the provider seam in Task 4 can be implemented independently with disjoint files. Controller integrates Task 5; Task 6 follows. Do not let concurrent agents alter the shared input contract independently.

## Task 1: Source-backed immutable history snapshots

**Files:** Create `src/observer/history-snapshot.ts`, `tests/observer/history-snapshot.test.ts`; modify `src/observer/local-session-reader.ts`, `src/observer/conversation-record.ts`, `tests/observer/local-session-reader.test.ts`, `tests/observer/local-session-cancellation.test.ts`.

**Interfaces:** Export from `history-snapshot.ts`:

```ts
export interface HistoryCoverage {
  complete: boolean;
  gaps: Array<'upstream_truncated'|'unsupported_payload'|'unattributed_record'|'unreadable_record'>;
}
export interface HistoryRecord {
  ordinal: number;
  record: import('./conversation-record.js').ConversationRecord;
}
export interface HistorySnapshot {
  // Local-only identities: never serialize these into provider messages.
  identity: string;
  sourceEpoch: number;
  revision: number;
  coverage: HistoryCoverage;
  records(signal: AbortSignal): AsyncIterable<HistoryRecord>;
  close(): Promise<void>;
}
```

- [ ] Add a fixture with 200 messages, an 8192-character user message, a tool result exceeding 256 KiB and a synthetic `sk-test-not-a-real-key` marker. Capture the byte high-water mark before appending another complete record; assert the snapshot excludes that append, while a subsequent snapshot includes it.
- [ ] Run `npm test -- --run tests/observer/history-snapshot.test.ts`; verify failure at the missing snapshot API, not fixture setup.
- [ ] Implement paged reading through a fixed watermark using the existing verified source resolution and identity checks. Save lightweight offsets, not all message bodies. If large-record parsing hits a resource bound, report unreadable content rather than skip it silently. Release handles on completion, cancellation and exceptions.

```ts
// Core behavior exercised with fixture-backed HistorySnapshot instances:
const received: HistoryRecord[] = [];
try {
  for await (const entry of snapshot.records(signal)) received.push(entry);
  expect(received.map(x => x.ordinal)).toEqual([...received.keys()]);
  expect(received.some(x => x.record.text?.includes('sk-test-not-a-real-key'))).toBe(true);
} finally { await snapshot.close(); }
```

- [ ] Add reset/replacement, partial-line, inaccessible attachment, duplicate-source-event and same-text-different-event cases. Unknown turn attribution is a gap/background record, never permission to bind it to the current turn. Never read attachment paths automatically.
- [ ] Run the three affected observer test files; commit their changes and the source files explicitly as `feat: add source-backed conversation snapshots`.

## Task 2: Lossless input assembly and separate lifecycle projection

**Files:** Modify `src/observer/context-owner.ts`, `src/observer/conversation-source.ts`, `src/observer/context-assembler.ts`, `src/estimation/observer-contract.ts`, `src/estimation/observer-input.ts`, `src/estimation/observer-retention.ts`, `src/estimation/pace-request-snapshot.ts`; create `src/estimation/prepared-context.ts`, `tests/estimation/full-context-input.test.ts`; update their existing observer/estimation tests.

**Interfaces:** `prepared-context.ts` exports:

```ts
export type ContextMode = 'full'|'compressed'|'incomplete';
export interface ContextRepresentation {
  mode: ContextMode;
  sourceComplete: boolean;
  originalRecords: number;
  compressedThroughOrdinal: number | null;
  sizing: 'tokenizer'|'conservative';
}
export interface PreparedContext {
  input: import('./observer-contract.js').ObserverInput;
  representation: ContextRepresentation;
}
```

Extend the strict input schema with this representation metadata and an optional history-summary field distinct from `goalSummary`. Keep event order, scope and tool pairing. Replace character/count policy caps with capacity enforcement in Task 3; preserve finite-number, role, shape and output validation.

- [ ] Add failing assertions that JSON round-tripping retains all 200 records, large bodies and the synthetic credential-like string; include an earlier-turn requirement and an unrelated conversation sentinel that must never appear.

```ts
const packed = JSON.parse(packObserverInput(input));
expect(packed.messages.map((m: {text:string}) => m.text))
  .toEqual(input.messages.map(m => m.text));
expect(packed.activeSeconds).toBe(input.activeSeconds);
```

- [ ] Run `npm test -- --run tests/estimation/full-context-input.test.ts` and capture the existing clipping failure.
- [ ] Remove credential filtering and text clipping from the estimator-only assembly/serialization path. Do not globally change `extractPassiveContent`, because hooks and unrelated consumers retain their existing contracts. Stop applying `retainObserverInput` as a hidden second selection pass.
- [ ] Retain a bounded lifecycle projection for `execution()` and takeover, but obtain estimator history from Task 1 snapshots through the current-turn boundary. Old goal-summary floors must not remove earlier context. Never turn a loading/error source into an apparently complete input.
- [ ] Test pause, terminal events, delayed hook/new-turn boundaries, late tool results and same-turn restart against existing tests. Run `npm test -- --run tests/observer/context-owner.test.ts tests/observer/conversation-source.test.ts tests/observer/context-assembler.test.ts tests/observer/source-goal-integration.test.ts tests/estimation/full-context-input.test.ts tests/estimation/pace-request-snapshot.test.ts`; commit as `feat: preserve complete readable estimator context`.

## Task 3: Trusted capacity and pure preparation planner

**Files:** Create `src/estimation/context-capacity.ts`, `src/estimation/context-preparation.ts`, `tests/estimation/context-capacity.test.ts`, `tests/estimation/context-preparation.test.ts`; modify provider configuration/host settings in `src/desktop/observer-provider-config.ts`, `src/desktop/observer-provider-host.ts` and their tests.

**Interfaces:** Export from `context-capacity.ts`:

```ts
export interface ContextCapacity {
  contextTokens: number;
  outputReserveTokens: number;
  requestBytes: number | null;
  source: 'provider'|'configured';
}
export interface RequestSizer {
  kind: 'tokenizer'|'conservative';
  count(serializedRequest: string): number;
}
export function requestFits(serializedRequest:string,
  capacity:ContextCapacity,sizer:RequestSizer):boolean;
```

`context-preparation.ts` produces either a `PreparedContext` or a typed preparation failure, consumes Task 1 history and Task 4 compression adapter. Sizing includes instructions/schema/messages and output reserve; byte limits are checked independently. A conservative estimator must document its supported encoding assumptions and be labeled approximate, not advertised as exact tokenizer output.

- [ ] Write boundary tests with a fake exact byte/token counter; test missing capacity, invalid reserve, non-ASCII payload and metadata overhead.

```ts
const sizer: RequestSizer = {kind:'tokenizer',count: s => s.length};
expect(requestFits('12345',{contextTokens:10,outputReserveTokens:5,
  requestBytes:null,source:'configured'},sizer)).toBe(true);
expect(requestFits('123456',{contextTokens:10,outputReserveTokens:5,
  requestBytes:null,source:'configured'},sizer)).toBe(false);
```

- [ ] Run `npm test -- --run tests/estimation/context-capacity.test.ts` and verify missing API failure.
- [ ] Implement validation and a provider/profile-scoped optional capacity configuration. Migrate old configuration losslessly; no invented model window default. Prefer trusted runtime/provider capability metadata when available. Unknown capacity becomes `capacity_unknown`, with an actionable settings state.
- [ ] Plan full transmission when it fits; otherwise select an oldest prefix for compression while preserving current requirements and recent tool evidence. An indivisible oversized required record yields `context_too_large`. No arbitrary record-count eviction.
- [ ] Test that under-capacity planning never calls a mock compressor and does not change text; test cancellation while paging. Run both new test files and provider-config regression; commit as `feat: prepare context against trusted model capacity`.

## Task 4: Accounted compression without execution authority

**Files:** Create `src/estimation/context-compression.ts`, `src/estimation/assets/context-summary-instructions.md`, `src/estimation/assets/context-summary.schema.json`, `tests/estimation/context-compression.test.ts`; modify `src/estimation/subscription-session.ts`, `src/estimation/observer-api-provider.ts`, `src/estimation/observer-provider.ts`, provider asset-copy/pinning modules, and subscription/API accounting modules and tests.

**Interfaces:** `context-compression.ts` exports:

```ts
export interface CompressionRequest {
  text: string;
  firstOrdinal: number;
  lastOrdinal: number;
}
export interface CompressionSummary {
  text: string;
  firstOrdinal: number;
  lastOrdinal: number;
}
export interface CompressionAdapter {
  // Implementation owns dispatch/accounting; never calls the ETA scheduler.
  summarize(request:CompressionRequest,signal:AbortSignal):Promise<CompressionSummary>;
}
```

- [ ] Write tests using a fake admitted transport: one successful compression settles one reservation; malformed output retains charged usage; post-dispatch disconnect records unknown usage; pre-dispatch cancellation does not pretend a model call occurred.
- [ ] Run `npm test -- --run tests/estimation/context-compression.test.ts` and verify red.
- [ ] Add a strict summary response schema (text and matching ordinal coverage only), read-only instructions and parsing seam through existing owned-process/API transport. Do not use the ordinary ETA response schema to parse a summary. Update trusted asset hashes through existing generation tools, never disable verification.
- [ ] Implement sequential per-conversation chunk compression, exact-prefix in-memory cache and single-flight preparation. Key cache by source epoch, covered-prefix digest, provider/model and preparation version; never put identities or hashes in the model prompt. Bound an automatic capacity-rejection retry to one; ordinary provider failures leave retries to the scheduler.

```ts
const summary = await adapter.summarize(request, signal);
if (summary.firstOrdinal !== request.firstOrdinal ||
    summary.lastOrdinal !== request.lastOrdinal || !summary.text.trim()) {
  throw Error('COMPRESSION_COVERAGE_INVALID');
}
```

- [ ] Reject stale/oversized summaries, preserve unresolved work and amendments in prompt requirements, and distinguish structural validation from semantic accuracy. Record `purpose: 'eta'|'context_compression'` as local accounting metadata; sum both for total usage without resetting existing unknown records.
- [ ] Run `npm test -- --run tests/estimation/context-compression.test.ts tests/estimation/subscription-session.test.ts tests/estimation/observer-api-provider.test.ts tests/estimation/release-accounting.test.ts tests/estimation/release-accounting-session.test.ts`. Commit as `feat: add accounted observer context compression`.

## Task 5: Scheduler, settings and diagnostic integration

**Files:** Modify `src/estimation/observer-scheduler.ts`, `src/estimation/observer-worker.ts`, `src/desktop/observer-runtime.ts`, `src/server/passive-goals.ts`, `src/core/observer-diagnostics.ts`, `src/ui/view-model.ts`, `src/ui/settings-renderer.ts`, `src/ui/settings.html`, `src/desktop/observer-settings.ts`, `src/evaluation/pilot-journal.ts`; create `tests/estimation/full-context-scheduler.test.ts`; update related UI/settings tests.

**Interfaces:** Expose preparation states `history_loading`, `context_preparing`, `context_full`, `context_compressed`, `history_incomplete`, `capacity_unknown`, `context_too_large`, `compression_failed`. Map to existing diagnostics without overwriting unrelated auth/rate-limit errors. The scheduler owns one cancellation scope spanning snapshot acquisition, preparation and observation for each request ticket.

- [ ] Write a mid-task scenario: append unique early user/assistant/tool markers before attachment, trigger once, and assert no observer call while initial history is loading. Once loaded, inspect the fake worker input for every marker.
- [ ] Write new-turn and profile-change tests resolving a delayed compressor after invalidation; assert no observation or HUD write from that ticket. Run `npm test -- --run tests/estimation/full-context-scheduler.test.ts` and verify red.
- [ ] Integrate asynchronous preparation before observer dispatch, not into synchronous `tick()`/HTTP handlers. Recheck existing source/turn/provider/authorization identity before each compression and ETA dispatch and before applying results. Existing numeric predictions retain normal stale/overdue handling during preparation.

```ts
// Required ordering, implemented using existing ticket ownership checks:
// acquire snapshot -> prepare -> revalidate ticket -> observe -> revalidate -> apply
// finally: close snapshot; release only resources owned by this ticket.
```

- [ ] Add capacity configuration to settings for profiles without trusted metadata; preserve login/config migration. Show representation and missing-history states in diagnostics; warn that task text is sent without redaction. Do not add repeated per-call consent popups.
- [ ] Add original/prepared size estimates and compression/ETA usage purpose to allowlisted journal metadata. Test with a synthetic secret sentinel that it appears in fake provider input but nowhere in diagnostic or journal JSON.
- [ ] Run new scheduler tests plus existing observer-scheduler recovery, UI and settings tests; commit as `feat: integrate full context observation lifecycle`.

## Task 6: End-to-end coverage and integration review

**Files:** Create `tests/integration/full-context-estimation.test.ts`, `docs/superpowers/reports/2026-09-12-full-conversation-estimation.md`; update the observer instructions and appropriate existing privacy/settings documentation without importing any personal research notes or raw conversation evidence.

- [ ] Add one fixture-backed end-to-end test covering attach-mid-turn, initial history, two incremental appends, pause/resume, source restart, compression and final current-turn completion. Use fake models, no network. Assert each request's covered ordinals and active-time boundary.
- [ ] Add a multi-conversation stress test with paged fixtures and a bounded retained-body counter; verify separate identity/summary caches, responsive cancellation and no raw-text persistence. Simulate unreadable history and unsupported payloads explicitly.
- [ ] Run `npm test -- --run tests/integration/full-context-estimation.test.ts`; fix only regressions within this scope.
- [ ] Run `npm run typecheck`, `npm run build`, `npm run check:plugin-sync`, `npm run validate:plugin`, then `npm test -- --run --maxWorkers=1 --no-file-parallelism`. Record exit codes/counts, not assumed success.
- [ ] Request the single consolidated `gpt-5.6-sol` / `medium` review focused on source trust, stale-ticket fencing, accounting, non-redaction boundaries, memory limits and specification coverage. One fix review maximum per user policy.
- [ ] Run an isolated packaged MCP/control smoke with mock/no estimation credentials; do not alter the installed HUD. Record which functionality is simulated and which is actually executed.
- [ ] Update the report with test evidence, remaining capacity/provider limitations, no-paid-call status and the extra compression cost model. Commit explicit files as `test: verify full conversation estimation pipeline`.

## Plan self-review

- History completeness/mid-task/restart: Tasks 1, 2, 5, 6.
- No hidden text filtering or arbitrary packet selection: Task 2 and diagnostic separation in Task 5.
- Capacity, unknown capability, long records, token/byte distinction: Task 3.
- Overflow compression, cache identity, accounting, cancellation: Tasks 4–5.
- UI, incomplete content, lifecycle independence and paper-safe metadata: Tasks 5–6.
- Snapshot and preparation interfaces are defined above; legacy observer input remains the final estimator shape, extended once in Task 2.
- Full tests, one review, no installation/publication/paid benchmark by implication: Task 6 and global constraints.
