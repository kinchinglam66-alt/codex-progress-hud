# Image context for persistent ETA

Status: approved direction; written specification awaiting user review.

## Outcome and decisions

The observer must receive actual available conversation images, including images added after a native checkpoint. A filesystem path or OCR summary is not equivalent to the image. Preserve message part order and cross-turn context inheritance. The user explicitly approved continuing estimation when historical images are missing, with a visible warning. Missing images must not be described as complete context.

Alternatives considered: discarding images violates the full-context requirement; OCR-only replacement loses visual information and introduces another inference path. Use native image content with an explicit missing-image representation.

## Architecture

1. Extend normalized conversation records with ordered text/image parts. Retain the existing text projection for current consumers, but do not serialize both projections as duplicate source text. Accept attachment references only from recognized native message content, never by extracting paths from quoted text or tool output.
2. Introduce a local attachment resolver between source parsing and provider import. Resolve only explicit attachment references. Validate regular files, file identity, supported image signatures and transport capacity; reject directory, device, network-path and symbolic/reparse indirection. Do not scan directories or fetch remote URLs. Preserve already embedded native image content without converting it to path text.
3. Resolve bytes within a bounded snapshot/import lifetime, compute content digests, and pass native input_image parts to the persistent session. Raw bytes and local paths must not enter diagnostic logs, accounting records or public evaluation artifacts. Do not introduce a permanent raw-image cache.
4. Extend persistent append beyond its current text-only payload. Preserve ordering and source ordinal identity. Commit the cursor only after every part has been acknowledged. Hash text and image content, not just paths. A changed image invalidates/rebuilds the affected session rather than silently appending a conflicting record. Repeated unchanged records are not re-imported.
5. Count encoded image bytes in transport/source budgets. Do not fragment an image into text chunks or guess image token usage from base64 length. Retain provider-reported usage; unavailable usage remains unknown under the existing completed-call accounting policy.

## Completeness and failure semantics

Separate inference eligibility from fidelity. Explicitly absent historical attachment files are non-blocking: preserve their position as a missing-image marker, tell the model the content is unavailable, and show “部分历史图片缺失” in HUD diagnostics and beside the applicable ETA. Keep the warning attached to the current source/session representation, including after compression, until a rebuilt source no longer has the gap.

Do not change sourceComplete to true for missing images. Add an explicit eligibility/quality representation that permits this one approved gap while preserving existing blockers. Unknown payloads, malformed records, untrusted attachment references, permission failures, unsupported formats and capacity violations remain distinct errors; they must not be reclassified as missing files. Exceeding capacity must not silently truncate or resize images.

Cancellation, account/source generation changes, ambiguous acknowledgements and unconfirmed process exit retain their existing fencing and cleanup behavior. No new retry loop or model-call authorization is introduced.

## Affected boundaries

- conversation-record and local-session-reader: ordered content and validated provenance.
- history-snapshot and scheduler preflight: quality versus inference eligibility.
- persistent worker/session: resolution, identity, native import and capacity accounting.
- observer contract, result/status propagation and HUD rendering: durable missing-image warning.
- context fingerprints: image-only messages and image changes must affect source validity.

The implementation must inspect non-persistent consumers too: an unsupported provider path must report incompatibility, never silently use a text-only projection while claiming full image context.

## Verification

Use synthetic local image fixtures and mocked RPC first. Tests must cover text/image/text ordering, image-only messages, post-checkpoint images, same-turn reuse, new-turn inheritance, duplicate replay, changed bytes at the same path, missing files, permission errors, malformed/unsupported images, reparse paths, transport capacity, cancellation and partial acknowledgements. Assert native image bytes arrive at RPC, not just that a parser accepts a new type.

Test that missing-image warnings survive result application and compression, disappear only with corrected/rebuilt context, and do not permit unrelated history gaps. Verify image bytes/paths are absent from diagnostics and receipts. Run focused tests during implementation and the full suite at the milestone; review security and session/accounting boundaries before installation.

Existing three successful synthetic inheritance tests remain functional evidence, not image compatibility or ETA accuracy evidence. This design does not authorize extra standalone real-image calls. After local verification, installation and normal enabled-runtime observation must demonstrate an actual accepted ETA before claiming normal operation. Request fresh consent if a separate real-image compatibility call is required.

## Non-goals

No OCR service, remote image fetching, automatic file discovery, image editing, new provider/account workflow, retrospective benchmark campaign, or unrelated startup refactoring. Preserve login, proxy, settings and accounting history.
