# Context planner responsiveness

## Reproduced cause

The history reader exposes buffered pages through an async iterator. Awaiting
an already-resolved iterator promise only schedules microtasks; it does not
necessarily allow timers, HTTP I/O or Electron callbacks to run. Context
preparation repeatedly assembles, validates and serializes retained messages for
capacity checks. Its synchronous suffix-eviction loop can amplify this work.

An offline local replay (no model calls, no source text exported) measured:

| Case | Before: maximum event-loop delay | After: maximum event-loop delay |
| --- | ---: | ---: |
| Smaller existing history | 914.9 ms | 32.7 ms |
| Large existing history | 57,243.9 ms | 34.4 ms |

The large-history probe's 30-second cancellation returned after approximately
61.55 seconds before the change and 30.05 seconds after it. A read-only scan of
the large history took about 4.4 seconds with a maximum loop delay around 70 ms,
isolating the much larger stall to preparation rather than simply disk reading.
The final replay overlapped the regression suite, so the numbers are not a
controlled throughput comparison. These are local diagnostic observations, not standardized benchmarks or ETA
accuracy results. They reproduce a cause consistent with the earlier endpoint
outage, not a captured CPU profile of that historical outage.

## Repair and invariants

Preparation now uses an eight-millisecond cooperative scheduling budget across
history traversal, suffix eviction and compression packing. Once the budget is
spent, a cancellable zero-delay timer handoff lets due timers and I/O run before continuing.
Abort checks occur before and after the yield, before compression dispatch and
after final serialization/metrics. A check-phase-only immediate can resume before
an already-due timer; the timer handoff covers the terminal-return case as well.
Existing snapshot cleanup remains
in the owning `finally` block.

Selection order, full-context policy, protected requirements, capacity limits,
compression validation/cache, model authorization and accounting are unchanged.
No user settings or data are migrated. No new model calls are introduced.

Eight milliseconds is a scheduling target, NOT a hard upper latency bound:
individual synchronous serialization/validation operations and OS scheduling can
take longer. The total repeated-sizing CPU cost is not reduced by this fix.
Large histories may still take substantial time to prepare or be cancelled.

## Verification

Regressions exercise cancellation of an in-memory buffered page, servicing a
timer while preserving all messages, and cancellation during a long eviction
pass. The first two failed before the fix; removing only the eviction yield made
the third fail (259 large sizing passes), and restoring it passed. Existing
context preparation, scheduler, worker and residual tests also passed.
Additional regressions assert `AbortError` after an expensive final serializer
and during compression packing, before invoking the compressor. Both failed
before the final cancellation checkpoints were added.
The compression regression targets the smaller chunk serialized by `flush()`
after overflow, not the earlier record-loop sizing. Removing only its
pre-dispatch checkpoint makes the test fail. The checkpoint precedes cache
lookup so a cache clear during the handoff cannot leave a captured stale hit.

Production installation and live UI/network verification remain separate steps.

Final local verification (2026-09-13): 190 test files / 2,227 tests passed,
TypeScript no-emit checking and build compilation passed, and `git diff --check`
was clean. Diagnostic source histories and local measurement records are not
included in this public document or the tracked changes.
