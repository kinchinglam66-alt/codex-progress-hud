# Full-context estimation — development branch

This document describes the implementation under validation, not a released or
installed version. No accuracy claim follows from protocol or unit-test success.

## Data flow

1. Bind the authenticated conversation and current turn to a source snapshot.
2. Read its existing user/assistant/tool records through a fixed byte watermark.
   Starting the HUD mid-turn includes earlier readable records, not just updates
   arriving after activation. Earlier turns remain background, not remaining work.
3. Keep a separate small lifecycle projection for clocks and task state. The full
   estimator source does not inherit that projection's text retention limits.
4. Size the request, including estimator instructions/schema and an output reserve,
   against trusted or explicit model capacity. Request bytes and tokens are distinct.
5. Send original readable text when it fits. Only after overflow, summarize an
   oldest prefix and retain recent original evidence and current requirements.
6. Recheck identity/cancellation before inference and before applying its result.
   User waits and pauses do not become active work because history was loaded.

## Capacity settings

Advanced provider settings accept a model name, context-window tokens, output
reserve and optional request-byte cap. Values apply only to that exact selected
model. Saving a capacity change does not replace a credential; save the draft and
activate it to apply. No context-window size is guessed from a model name.

`capacity_unknown` asks for a usable capability/configuration. An indivisible record
that cannot fit yields `context_too_large`; it is not silently clipped. Conservative
UTF-8 sizing is marked approximate and is not an exact tokenizer measurement.
An output reserve is not a measured token charge or a promise of estimation quality.

## History and cost

Readable source is not the executing model's hidden reasoning or guaranteed complete
internal context. Missing source, upstream truncation and inaccessible attachments
are visible gaps. The plugin does not open arbitrary referenced files to fill them.
Task text is not privacy-filtered. Review the selected recipient before enabling it.

Source deduplication retains a rolling window of 4,096 hashed identities rather
than an index growing with the conversation. Once that window evicts an identity,
later readable records are still included, but `deduplication_window` marks the
representation incomplete: far-apart mirrored records may repeat. This is a
metadata-memory bound, not a 4,096-record transcript cutoff.

Overflow compression uses the same selected model/account/provider and consumes
additional allowance. Per-conversation compression is sequential; conversations
remain independent. Exact prefix summaries can be reused within a bounded in-memory
cache scoped to source/provider identity. Cache hits do not require another summary
call; restart discards the cache. No raw transcript cache is written by this feature.

Local research metadata separates original text size from complete prepared request
size and records compression/cache counts. Original-text token estimates exclude
protocol overhead; prepared estimates include the supplied serialization overhead.
Both are sizing estimates, not billed usage. Durable accounting records actual known
usage and preserves unknown usage; missing usage must not be interpreted as zero.

## Acceptance boundary

Offline tests can establish record coverage, identity isolation, cancellation,
capacity handling and accounting transitions. They cannot establish semantic summary
fidelity, ETA error rates, provider retention or real-network reliability. Long-task
accuracy testing must separately retain forecast timestamps, active-time completion
boundaries, actual usage and per-stage errors. Do not mix these with synthetic
connectivity or schema checks.
