# Full-conversation context for ETA

Status: proposed technical design; user review required before implementation.

## Confirmed product contract

The estimator receives all readable user messages, assistant messages, tool calls and tool results from the current conversation, including records that predate HUD installation, startup or first observation. Earlier turns are background; the prediction horizon remains the remaining active work of the authenticated current turn, not the entire project. User waits and pauses remain excluded.

Do not apply privacy redaction or credential-pattern filtering to task text in this mode. Text may contain private code, logs and credentials, and will be transmitted to the user's configured estimation provider. This does not authorize collecting plugin authentication files, environment secrets, unrelated conversations, or repository contents that were never present in the conversation. Read-only observer instructions, authentication, source identity checks, schema validation and tool-execution prohibitions remain mandatory. Conversation text is untrusted data, never instructions for the observer to execute.

Only model/request capacity overflow permits automatic compression of older text. Do not silently omit records to satisfy the previous 128-message, 4096-character, 16/32/64-KiB packet or 256-KiB retained-history limits. UI and diagnostics distinguish full text, compressed history, loading, unavailable history and capacity failure.

## Scope and alternatives

1. Raise the final packet limit only: rejected because upstream eviction and extraction already discard history.
2. Complete-history reading with capacity-aware preparation: selected. Keep original records readable, incrementally collect updates, send a complete snapshot when it fits, and summarize old history only when necessary.
3. Persistent provider conversation with incremental messages only: deferred. It creates provider-specific state and recovery requirements and cannot serve as proof that a fresh observation contains the required history.

This changes input preparation, not the main task model, task execution, lifecycle authority, ETA target, automatic authorization policy, parallel-estimation policy or completion semantics. No benchmark rerun or release publication is included.

## Current implementation and affected boundaries

- `src/observer/local-session-reader.ts`: bounded JSONL reading and record normalization must be audited for oversized-line skips, body clipping, source resets and upstream truncation.
- `src/observer/context-owner.ts`: currently evicts record bodies above 256 KiB per conversation and imposes an 8-MiB combined memory limit. Replace destructive context eviction with source-backed paged access and bounded working memory.
- `src/observer/conversation-source.ts`: current turn/floor selection must separate lifecycle selection from all-history estimator selection. Earlier records must not change current-turn timing or completion.
- `src/observer/context-assembler.ts`: removes wrappers, extracts filtered content and clips actions/summaries. Task records must instead preserve readable text, role, chronological order and event pairing; host protocol envelopes must not become executable instructions.
- `src/estimation/observer-contract.ts`, `observer-retention.ts`, `observer-input.ts`: replace arbitrary text/count truncation with validated prepared-input metadata and provider-capacity checks. Serialization must not perform a second hidden truncation.
- Subscription/API invocation and scheduler: accept prepared snapshots, surface preparation state, account for compression calls, cancel stale work and preserve existing ownership fences.

## History and snapshot ownership

Bind each read to the verified conversation source, its identity/epoch and the authenticated current turn. Establish a high-water mark at observation preparation so an actively growing file cannot keep initial loading open indefinitely. Read all complete supported records through that watermark; later records belong to a subsequent snapshot. Preserve tool starts/results and distinguish actual duplicate source events from identical text sent twice.

At first mid-task observation, display history loading and do not infer from a partial catch-up packet. On later observations, reuse source indexes and read only changes, but construct the effective input from the complete history through the new watermark. Do not repeatedly serialize every intermediate catch-up batch.

On restart, rebuild from the conversation source. Existing ETA checkpoints may continue their separately defined recovery behavior, but are not a substitute for history. Source truncation, replacement or account/conversation changes invalidate indexes, compression caches and in-flight snapshots. A partial final JSONL line is not silently treated as a complete record.

Keep memory bounded with paged reads and lightweight indexes; do not load an arbitrarily large log synchronously on the HUD event loop. Resource exhaustion produces an explicit preparation failure, not an undocumented selection of recent text. Do not add persistent copies of raw conversations for this feature; use the existing source and bounded, discardable in-memory caches.

## Meaning of complete

Complete means all supported readable conversational records present in the verified source at the snapshot boundary. It does not include hidden reasoning, inaccessible/removed history, or inferred contents of attachment paths. Image or binary payloads require supported extraction/provider handling; unsupported payloads and source-provided truncation must be represented as unavailable content, not silently advertised as full context. No automatic retrieval of arbitrary files referenced in messages.

Use separate metadata for source completeness and transmission representation. A source may be complete while the transmitted earlier history is compressed. A missing record is not equivalent to a summarized record. Preserve sequence coverage and explicit gaps. Unknown earlier active work time remains unknown even when earlier text is available.

## Capacity and compression

Determine the selected model's input budget from trusted provider capability metadata or explicit local model configuration, reserving space for observer instructions, schema, serialization overhead and output. Do not infer context capacity from task text or invent a fixed capability for a model name. If capacity is unavailable, report that configuration/capability problem rather than silently applying the former packet limit.

Count the actual prepared request using an available model-compatible tokenizer; otherwise label conservative sizing as approximate. Provider request-size limits are distinct from token limits. A capacity rejection may initiate a bounded preparation retry with a smaller verified budget; authentication, rate-limit and network failures must not trigger destructive compression.

If the complete input fits, send all readable text unchanged. If it does not fit, summarize the oldest covered prefix using the same configured observer account/provider/model, retaining the newest suffix verbatim. Preserve amendments, superseded decisions, remaining work, failures, tool outcomes and uncertainty; summaries must not invent completion or elapsed work. Current-turn original requirements and the active tool start/result pair have priority for verbatim retention. If a single record or the required recent suffix cannot fit, expose capacity failure rather than secretly clipping it.

Compression is an additional model call and consumes usage. It uses the existing authorization, cancellation and accounting mechanism, with no tool authority or new login. Do not recursively invoke the normal ETA scheduler to summarize. Process bounded chunks sequentially per conversation; cache reusable summaries by source identity, covered prefix, model and preparation version. Reuse only an exactly matching prefix, invalidate on source changes, and discard caches on restart. Avoid concurrent compression of the same prefix. Preparation failure does not disable the main task or declare completion.

Summary content remains untrusted. Validate coverage, output shape and size locally; structural validation cannot prove semantic completeness. Record compression as lossy and increase uncertainty instructions accordingly. If compression fails, retain any existing estimate according to its current stale/overdue rules, clearly show the preparation failure, and use existing retry scheduling rather than an unbounded immediate retry loop.

## UI, diagnostics and accounting

Show concise preparation states: reading history, full readable context, earlier history compressed, history incomplete, or context exceeds capacity. Detailed diagnostics expose source coverage, original/prepared token estimates, compression coverage and failure category without storing task text or credentials. Removing input redaction does not remove diagnostics/logging privacy restrictions.

Record ETA and compression usage separately and together. Unknown usage remains unknown; do not treat it as zero. No main-task model call is required for history preparation. A late compression or ETA response cannot update another turn, conversation, source epoch, provider profile or authorization generation.

## Verification and acceptance

1. Install/enable halfway through a task: unique markers from early user, assistant and tool records appear in the captured estimator request before the first ETA call.
2. Prior turns remain included as background; current-turn active time and terminal signals remain authoritative.
3. More than 128 messages, a message longer than 4096 characters and history beyond 256 KiB remain intact when the configured model/request budget permits.
4. Incremental observations contain both original history and newly appended complete records, without duplicate accumulation.
5. Restart, file rotation/truncation, concurrent appends and partially written records cannot mix epochs or falsely report complete coverage.
6. Under-capacity preparation invokes no summarizer and preserves task text, including synthetic credential-like fixtures. Never use real secrets in tests.
7. Overflow invokes accounted compression only; coverage is explicit, recent text is retained, prefix cache reuse works, and provider failure has bounded retry behavior.
8. Unsupported attachments, missing history, unknown capacity and oversized indivisible records are visible degraded states.
9. Cancel/disable/new turn/profile change during reading or compression rejects stale output and releases only owned resources.
10. Multi-conversation loading stays isolated and responsive with bounded memory; no raw input appears in diagnostics or public artifacts.
11. Run focused tests during implementation, a full regression at integration, and one isolated no-paid-call package smoke. Real provider calls require a bounded test proposal before execution.

## Delivery sequence

After review of this spec, create a concrete implementation plan covering source-backed reading, prepared-input contracts, capacity/compression orchestration, scheduler/UI/accounting integration and regression tests. Implement in an isolated branch, preserve existing installation and user data, and do not merge/push/install without the user's instruction for that step. This document does not claim the feature is implemented.
