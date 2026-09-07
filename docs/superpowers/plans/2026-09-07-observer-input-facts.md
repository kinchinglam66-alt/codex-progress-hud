# Observer Input Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Preserve factual event relationships and disclose context loss within the existing observer input pipeline.

**Architecture:** Extend optional message metadata, then share one pure retention function between assembly and packing. Keep ordered text, existing filtering, private stdin and legacy inputs compatible.

**Tech Stack:** TypeScript, Zod, Vitest, Node UTF-8 byte accounting.

**Spec:** docs/superpowers/specs/2026-09-07-observer-input-facts-design.md

## Global Constraints

- Keep the 16,384-byte final UTF-8 ceiling and existing field bounds.
- No model, frequency, authentication, response-schema or installation changes.
- No raw conversation, turn, event or action identifiers in new metadata.
- Synthetic fixtures only; input tests are not ETA accuracy evidence.
- Continue in main as previously explicitly requested; no push or installation.

## Task 1: Input contract, assembly and retention (one coupled deliverable)

Files: src/estimation/observer-contract.ts, observer-input.ts,
new observer-retention.ts; src/observer/context-assembler.ts;
tests/observer/context-assembler.test.ts and tests/estimation/observer-input.test.ts.

Interfaces: optional message.event {ordinal, kind, atMs, pairOrdinal?, counterpartMissing?};
optional packingLoss {suppliedMessages, retainedMessages, droppedByKind, clippedMessages}.
Shared retainObserverInput(packet: ObserverInput): ObserverInput updates owned packet
after filtering, preserves first/latest users and latest assistant, removes old tools
before intermediate users, and caps message count, aggregate text and encoded bytes.
Repeated packing must leave the loss counts and packet stable.

- [x] Add tests through assembleContext -> packObserverInput -> observerInputSchema.
  Example fixture: user objective, tool_start/action A, tool_result/action A,
  user amendment; assert matching numeric pairOrdinal, original atMs, no raw IDs.
- [x] Add a second turn reusing action A; assert distinct pairOrdinal. A lone result
  must have counterpartMissing=true, not fabricated success.
- [x] Add large multilingual/credential-expansion fixtures; assert first/latest
  user text survives, byte length <=16384, loss supplied=retained+sum(dropped),
  and packObserverInput(JSON.parse(packed))===packed. Assert caller unchanged.
- [x] Run `npx vitest run tests/observer/context-assembler.test.ts tests/estimation/observer-input.test.ts` and observe new assertions failing.
- [x] Implement optional bounded Zod metadata, snapshot-local pair mapping scoped
  by turn, and shared deterministic retention. Example invariant:
  `packet.packingLoss.retainedMessages = packet.messages.length`.
  Clipped count measures clipped retained messages; dropped counts are cumulative
  within this snapshot. Upstream missing history remains separately marked.
- [x] Preserve legacy inputs without adding loss metadata unless assembly supplies
  it; both paths still use the same retention priority and filtering.
- [x] Re-run focused tests, typecheck and build; resolve integration failures.

## Task 2: Instructions and final verification

Files: src/estimation/assets/observer-instructions.md, src/estimation/asset-pins.ts,
this plan and the associated spec status.

- [x] Explain ordered requirement messages, prior-summary uncertainty, factual
  event ordinals, missing counterparts and local-only loss counts in instructions.
- [x] Compute only the changed instructions asset hash using Get-FileHash and update its pin;
  do not alter response schema, executable or observer-home pins.

No pin-generation script exists in this repository; the SHA-256 was calculated
from the final LF instructions asset and patched explicitly. No other pin changed.
- [x] Run asset-pin and observer input tests, build, and one full suite using
  `npm test -- --run --maxWorkers=1 --no-file-parallelism --reporter=dot`.
- [x] Request one scoped independent review including interface/privacy risks;
  follow user policy: Sol medium final review, at most one fix review.
- [x] Record actual results, unresolved limits and source-only status. No claims
  of improved ETA accuracy without a separate evaluation.

## Results

- Initial new integration tests failed for missing event and packing-loss metadata.
- Initial complete suite: 124 files / 1,471 tests passed before review fixes.
- One Sol/medium review found three issues: message/event type mismatch, reused
  action IDs within a turn, and equal-length credential replacement loss marking.
- All three were reproduced with failing tests, then fixed together. Added an
  overlapping duplicate-ID case: ambiguous counterparts remain missing.
- Scoped fix review found no actionable findings or new regressions.
- Final full suite: 124 files / 1,476 tests passed, 301.47 seconds. Typecheck,
  build, asset-pin validation and diff whitespace check passed.
- Synthetic large-log case: 142 supplied, 5 retained, 137 tool messages dropped,
  3 clipped/filtered retained messages, 13,287 UTF-8 bytes, stable repeat packing;
  first requirement and newest amendment retained. This is not ETA accuracy data.
- No inference calls, dependency changes, installation changes or network publication.
- Legacy inputs without packingLoss remain accepted. ClippedMessages includes
  filtered retained text; counts describe only the supplied snapshot. Raw source
  identity fields are replaced by numeric local references, not stripped out of
  arbitrary task prose. Existing credential filtering remains best effort.
- The final changes are local source edits on main; commit/push/install are separate
  user-controlled handoff actions.
