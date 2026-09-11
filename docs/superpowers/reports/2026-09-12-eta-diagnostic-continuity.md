# ETA diagnostic continuity

## Approved scope

Add precise host rejection diagnostics and best-effort call-stage observations. Keep the existing acceptance, authorization, concurrency, retry and accounting rules unchanged. Correct local research aggregation across runtime sessions separately; no private research artifacts belong in this repository.

## Call stages

Subscription calls can report admission, preparation, reservation, dispatch, provider_returned, settlement, cleanup and finished. API calls report the applicable stages in their actual execution order; an API retry can repeat stages within one scheduler request.

Stage events contain only allowlisted codes and the existing opaque request metadata. They do not include prompts, credentials, provider response text or account identifiers. Diagnostic callbacks are synchronous, best-effort and exception-isolated; journal buffering and byte limits remain in place.

A stage indicates entry into a local operation, not proof that it completed successfully. In particular, dispatch does not prove provider billing, settlement does not prove a durable commit, and finished does not replace a result's cleanup/accounting evidence. Only result records close journal pending-request entries. An interrupted journal with no result remains unresolved, never zero-cost or automatically successful.

## Rejection diagnostics

Preserve the boolean PassiveGoals settlement contract and existing guard order. Store an allowlisted reason against the opaque ticket and forward it through scheduler diagnostics and the journal. This identifies source/measurement epoch changes, instruction identity changes, unavailable context, invalid responses, incompatible runtime state, and scheduler cancellation or disablement without relaxing their fences.

## Research identity

Request IDs, forecast revisions and active clocks are runtime-local. Cross-session analysis must namespace IDs, detect reset boundaries, and use independent native turn boundaries for actual remaining time. Do not infer that a new nearby call belongs to the benchmark from its timestamp alone.

## Limits

This change improves observability; it does not establish the cause of a historical process exit or reconstruct a missing historical response. It does not by itself demonstrate improved ETA accuracy. Installation and live verification are separate steps; this development pass performs no paid model calls and leaves the installed companion and account data untouched.

## Verification

- Focused red tests demonstrated missing stage callbacks, missing stage persistence and missing wrapper forwarding before implementation.
- Fresh full regression after offline dependency setup: 164 files, 2,015 tests passed, exit 0 (317.40 seconds).
- TypeScript checks, production build and `git diff --check` passed.
- Independent production review found no critical or important issues and confirmed existing acceptance/auth/accounting policy preservation.
- Separate local research scripts passed 12 offline tests for runtime-local ID collisions, reset revisions, causal sampling bounds, late-result costs and independent task clocks. Checksums confirmed 19 original experiment artifacts unchanged; research data and reports remain outside this repository.
- The initial full-run attempt failed due to missing worktree-local TypeScript/Electron dependencies, not accepted as a passing run. Offline installation and reuse of the same-version local Electron binary resolved those environment failures; the subsequent full run above had no failures or skipped tests.
