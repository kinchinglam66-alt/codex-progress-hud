# Native-seeded same-turn observer reuse

Status: implemented as an opt-in candidate; Series16/17 provide synthetic lifecycle and source-correction evidence. Not enabled in the installed default and not performance-qualified. Series18 stopped on an accounting evidence gap; the narrow repair has focused local verification and Series19 is registered for fresh qualification after full regression. User permits design adjustment without repeated approval. This is an explicit alternative to the earlier fresh-child-per-estimate requirement, not a silent relaxation of that requirement.

## Decision and alternatives

Retain the immutable native completed-turn base. Create one isolated estimation child for a source turn and reuse that child for subsequent estimates in the SAME source turn. Inject quoted source records as separate messages from the first call; do not use the one-shot inline supplement path in this mode. Append only records not already acknowledged, and append a new currentObservation for each prediction. Never run tools or the source task in the observer.

Alternative A, fresh child every estimate, remains the default and comparison control: strongest exclusion of earlier observer answers, but Series15 found zero cache hits and approximately 123.6k input tokens per request. Alternative B, deprecated rollback/reset, is rejected: exact restoration is unverified and may remove reusable cache endpoints. Chosen alternative retains old observer answers as explicitly NON-source historical predictions. Model anchoring on those answers is a real residual risk, not eliminated by instructions; evaluate it before promotion.

## Source and lifetime contract

- Reuse requires the same conversation identity, source epoch, current source turn, base key/completed boundary and account/route/assets binding, a healthy owner, confirmed previous operation, and valid existing retention permit. Source revisions may grow; they may not regress.
- New source turn always receives a new estimation child and a newly validated base covering completed source turns. Do not inherit observer predictions into that base. A healthy process may remain according to existing process-retention rules.
- Each request reacquires authorization, account evidence and acceptance proof. Conversation reuse is not authorization reuse. No change to TTLs, resource limits, ledger rules, provider choice or installed defaults.
- End, cancellation, invalid source, changed account, uncertainty or process loss discards reusable session state through existing owner cleanup. No automatic retry of an ambiguously dispatched call. A later independently admitted request may rebuild from its validated source.
- First source turn uses an isolated empty session with the same append semantics.

## Delta correctness

Local source snapshots currently enumerate a fixed watermark from ordinal zero. The first implementation must replay/validate the existing current-turn prefix locally; this is not a claim of zero local reading. The existing append hashes detect rewritten records, but a shorter snapshot must also be explicitly rejected before appending or invoking the model. No skip-by-count without digest validation.

Canonical source-turn aliases must remain stable across estimates. Prefix comparison includes text, multimodal content and attachment changes. Validate the entire fixed snapshot before dispatch; no inference on gaps or an unverified shortened prefix. Advance the acknowledged source cursor only after successful injection acknowledgement. Any partial injection/cancellation poisons that session and rebuilds later; never pretend the remote injection was undone.

Prior currentObservation/ETA responses remain ordinary observer history, outside source record accounting. They do not advance the source ordinal, completion status or elapsed active clock. Trusted instructions already label predictions as non-source; maintain that distinction during native compaction and explicitly test adversarial old predictions against newer source corrections.

## Implementation boundary

Add an internal, default-false `reuseNativeTurnSession` worker option requiring completed-turn native context and excluding inline supplements. In `ensure`, reuse only after account binding and source/base validation, before constructing a new session. Do not return early around custody checks or retain request authority across release. Keep per-turn aliases/attachment tracking on reuse; clear them on generation reset.

Before wiring reuse, introduce a focused session-level complete-prefix validation operation over canonical PersistentSourceRecord values. It must reject changed prefixes, gaps and truncated snapshots, including after compression. Existing non-inline append already supports repeated estimates; do not remove SESSION_SUPPLEMENT_ALREADY_SUBMITTED guards from the one-shot inline mode.

Extend the diagnostic registry deliberately: reuse is allowed only for a request bound to the same source turn/base/owned child; new-turn child remains distinct. Report child-created versus child-reused explicitly, never label reuse as a fresh fork. Default-mode registry assertions remain unchanged.

## Verification and promotion

1. Unit tests: identical replay, growing source, shrinking/rewritten prefix, changed image, cancelled partial append, stale revision/base, new turn, account change, retained authority invalidation, old ETA not counted as source.
2. Worker integration: two estimates use one child in candidate mode; fresh-child default unchanged; new turn creates another child; distinct accounting operation and acceptance proof each time; all owners closed.
3. Synthetic runtime test only after local tests and one bounded architectural/accounting review. Compare same-turn ordinary-cadence calls, known/cached/unknown usage, preparation, inference and delivery. Include conflicting source correction after an intentionally misleading old prediction. Do not infer accuracy from context retrieval alone.
4. Fresh native cold-start benefit must remain; warm results must demonstrate reproducible improvement without source/usage/cancellation regressions. No installation from one favorable latency sample. Preserve all failures and unknown usage. Cache improvement is a hypothesis, not a guarantee.

No real history transfer, model migration, API-key route, cross-conversation state sharing, public/private document publication, merge, push or installation is part of this design milestone.
