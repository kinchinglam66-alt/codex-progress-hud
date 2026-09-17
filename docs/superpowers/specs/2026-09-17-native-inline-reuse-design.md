# Native first-request inline submission with retained same-turn reuse

## Decision and authority

Architectural extension of the internal completed-turn candidate, under the user's standing instruction to adjust the design and implement without repeated approval. No production/default switch, installation, merge or push in this milestone. Existing split-v2 gates are unchanged.

## Evidence and alternatives

Series27: 1710.066ms of 1722.957ms supplement preparation was one inject_items RPC. Local assembly is not the dominant observed cost. Series15 inline reduced preparation but did not consistently improve delivery and all cache counters were zero. The current inline session is one-shot, while the retained candidate requires append-only prefix verification. Simply enabling both flags is invalid.

Chosen: inline the initial complete eligible supplement into the first ETA request, then retain that successfully completed child and inject only new source records for subsequent estimates. This removes the first injection round trip while preserving the demonstrated retained-child cache opportunity. It does not guarantee faster inference or solve larger full-context token consumption.

Rejected for this slice: repeated inline deltas require a broader multi-request pending-submission state machine without evidence that ordinary same-turn delta injection is expensive (Series25 supplement import22ms). Keep that as a separate measured decision. Also reject returning to fresh children for every estimate: that discards the current cache-reuse design. No history pruning or lossy replacement.

## Source acceptance state

Introduce an opt-in session capability `retainSubmittedSupplement` (default false), enabled only by the internal worker combination of completed-turn native context, same-turn reuse and inline initial supplement.

Maintain a canonical accepted source ordinal plus per-record digest independently of transport statistics. A record is accepted after either an empty injection acknowledgement or an inline request that completes successfully with a valid interpretation, no cancellation and all evidence writes completed. An initial turn/start id alone is only submission, not acceptance. The worker's own successful accounting/authorization checks remain required before retaining the process.

Keep existing cursor/importedRecords/importedEncodedBytes for actual injection evidence; do not count inline records as injected. Expose acceptedThroughOrdinal as a separate diagnostic/representation field. Keep submittedRecords/submittedThroughOrdinal as truthful cumulative submission evidence, not an in-flight flag. Legacy inline remains one-shot.

On successful eligible initial inline completion, commit copied records' digests and canonical accepted ordinal atomically, charge their encoded source bytes to resident capacity, and permit subsequent appendSnapshot validation. Source digests use the existing text or JSON[text,content] encoding. A full snapshot must match every accepted ordinal before any new remote mutation. Rewrite, shrinkage, gap, cancellation, failed output, ambiguous terminal state or evidence failure invalidates the session; no same-child automatic retry. New source turn creates a fresh child/base under existing boundary rules.

## Transport and capacity

Stage only the existing bounded eligible text prefix on a fresh session (maximum32 records, existing byte/frame/context checks). Copy caller data before awaiting. Images, oversized records and combined observation/schema overflow preserve complete existing injection fallback; never omit content to enable this path. Stage the complete snapshot only after coverage/missing-image checks. Subsequent snapshots use appendSnapshot and only append the unaccepted suffix, even if the first prefix used inline transport. An unchanged snapshot causes no injection.

Frozen request input remains owned before admission. If pre-admission fallback flushes staged records, no inline acceptance is claimed. Resource byte accounting includes accepted inline bytes exactly once. Compaction tracking must use canonical accepted source ordinal, not falsely claim an injected ordinal covered the inline prefix. Existing compaction evidence/unknown-use handling remains unchanged.

Prior observer output remains non-source reference material. It must never populate source digests, source snapshots or a completed-source base. Main conversation is never written by the observer. Account binding, request proofs, source boundary validation, owned resource limits and terminal/accounting fences are unchanged.

## Validation and promotion

Local tests must cover initial inline success followed by exact replay/no injection, append-only delta/one injection, rewrite/shrinkage/gap rejection before RPC, cancellation/invalid interpretation/malformed acknowledgement/evidence failure rejection, full image/oversize fallback, byte accounting and legacy one-shot behavior. Worker tests must prove two estimates use the same child only within the same source turn and a new turn gets a new child. No test may fabricate a production release permit bypass.

After focused tests/typecheck/build, one architecture/accounting review and fixes, run a registered synthetic compatibility experiment before performance qualification. Record source visibility markers, all token counts including unknown usage, source framing, native spans and cleanup. Existing split-v2 source sizes, alternating order, stage parity and cost gates continue to apply; compatibility alone does not authorize installation. Do not claim this addresses the unmeasured same-turn307ms remainder or the new-turn token/cache regression until measured.
