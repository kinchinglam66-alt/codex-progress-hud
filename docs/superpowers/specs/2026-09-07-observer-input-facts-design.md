# Observer input facts: first-stage design

Status: proposed after inspection; implementation pending design review.

## Scope

Improve factual context supplied to the independent ETA observer. Reuse the
existing conversation reader, per-conversation context owner, assembler and
private-stdin packer. Do not change inference frequency, model, authentication,
goal classification, response schema, UI, or successful-observation cursor rules.
Do not add model summarization calls or publish real task records.

## Existing behavior and gaps

- ConversationRecord already separates user, assistant, tool_start, tool_result
  and runtime, with time and action identifiers.
- assembleContext currently discards those distinctions when building messages.
- observation already contains active-time completeness, history completeness,
  current action, previous estimate and summary watermark.
- assembleContext protects the first and latest user messages, but the final
  packObserverInput instead protects the latest user and assistant. Subsequent
  credential filtering can expand text and trigger another destructive selection.
- Truncation booleans/categories exist; they do not quantify omitted messages or
  identify whether tool counterparts were removed.

## Proposed changes

1. Add optional bounded factual metadata to input messages: snapshot-local event
   ordinal, event kind, observed timestamp and snapshot-local tool-pair ordinal.
   Never transmit raw conversation, turn, event or action identifiers. Ordinals
   are local references, not persistent identities or completion claims.
2. Preserve the ordered messages array. Metadata distinguishes user requirements,
   assistant statements and tool facts without duplicating their text in sections.
   Keep goalSummary explicitly described as a prior model interpretation, and
   retain the existing observation section for clocks and forecast history.
3. Use one deterministic retention policy across assembly and final byte packing:
   protect first/latest user requirements, then recent assistant context and tool
   pairs. Retain intermediate user amendments ahead of tool logs. If a pair cannot
   fit, explicitly indicate a missing counterpart; never fabricate its result.
4. Add optional packing-loss metadata: supplied/retained message counts, dropped
   counts by kind, and clipped-message count. These describe this input snapshot
   only; historyComplete remains the authority on upstream history availability.
   Filtering and byte clipping must update these fields consistently, including
   through repeated validation/packing. Do not count credential replacement as
   task completion or expose removed credential content.
5. Keep the 16,384-byte final UTF-8 ceiling and existing field bounds. Include all
   metadata in that budget; explicitly mark any protected text clipping. Do not
   introduce the previously suggested 8,000-token budget in this stage.
6. Preserve immutable caller input and deterministic output. Treat metadata and
   task text as untrusted data in observer instructions. Do not infer success from
   tool execution, absent messages or an assistant summary.

## Alternatives

- Only edit the prompt: cheapest, but cannot restore discarded event relationships.
- Replace the reader/context store: unnecessary; existing isolation and records
  already provide the foundation.
- Extend the existing input contract and unify retention (recommended): bounded
  interface change without a second pipeline or additional inference.

## Verification

Use synthetic fixtures only: initial objective plus multiple amendments; tool
start/result matching; identical tool IDs in different turns; missing counterpart;
credential-filter expansion; multilingual byte limits; repeated packing; caller
immutability; history gaps; and two independent conversation snapshots.
Exercise the actual assembler-to-packer-to-schema path, not source-text assertions.
Run focused regressions, typecheck/build and one full suite at the final milestone.
Review the input-contract and retention change before installation. Input quality
tests do not establish improved ETA accuracy; a later time-bounded replay evaluation
with independent completion labels is required for that claim.
