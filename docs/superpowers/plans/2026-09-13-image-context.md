# Image Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import actual conversation images into persistent ETA, continuing with an explicit warning only when historical images are missing.

**Architecture:** Preserve ordered source parts, resolve attachments locally, then inject native image parts. Keep fidelity distinct from permission to estimate; missing files are the only newly permitted fidelity gap.

**Tech Stack:** TypeScript, Node filesystem APIs, Vitest, existing native Codex RPC and Electron HUD.

**Spec:** docs/superpowers/specs/2026-09-13-image-context-design.md

## Global Constraints

- No extra standalone real-image model call without fresh consent.
- Preserve login, proxy, settings and accounting history.
- No permanent raw-image cache, remote fetching, OCR, silent truncation or resizing.
- Do not read paths extracted from quoted text or tool output.
- Unknown usage remains unknown, separate from confirmed completion.
- Run focused tests while implementing; full suite at the milestone. One final security/session review and at most one fix review per user routing policy.

## Task 1: Ordered source content

Files: modify src/observer/conversation-record.ts and src/observer/local-session-reader.ts; test tests/observer/history-snapshot.test.ts.

Interface: optional `contentParts: ConversationContentPart[]` on ConversationRecord; union text `{type:'text',text:string}`, local attachment `{type:'local_image',path:string}`, embedded `{type:'input_image',imageUrl:string}`. Only recognized native message content creates these parts. Text-only legacy records remain compatible. These are local source references, not provider-ready payloads.

- [ ] Add fixture after a checkpoint with native UserMessage content text/local_image/text. Assert ordered contentParts and unchanged text projection; assert no unsupported_payload gap. Add image-only, malformed image, unknown part and changed-image-path dedupe cases.
- [ ] Run `D:/node.exe node_modules/vitest/vitest.mjs run tests/observer/history-snapshot.test.ts`; confirm failure is missing image support.
- [ ] Normalize parts without filesystem reads. Include contentParts in dedupe identity. Recognized local_image must have a nonempty string path; malformed shapes stay errors. Do not alter legacy live parsing until its consumers can retain image identity.
- [ ] Re-run focused tests and typecheck; checkpoint the tested source changes.

```ts
expect(record).toMatchObject({text:'beforeafter',contentParts:[
  {type:'text',text:'before'}, {type:'local_image',path:'C:/fixture/image.png'},
  {type:'text',text:'after'}]});
```

## Task 2: Snapshot-lifetime image resolution

Create src/observer/image-attachment.ts and tests/observer/image-attachment.test.ts.

Interface: `resolveImageAttachment(part, {signal,maxEncodedBytes})` returns `{state:'available',imageUrl,digest,encodedBytes}` or `{state:'missing'}`. Takes only image variants of ConversationContentPart. Throw typed sanitized errors for other failures.

- [ ] Write tests with actual temporary PNG/JPEG/GIF/WebP fixtures, absent path, directory, malformed signature, capacity limit and cancellation. Assert decoded returned data equals original bytes. Filesystem mocks are limited to hard-to-reproduce permission/reparse races.
- [ ] Run test file and verify RED, then implement regular-file and ancestor checks, bounded reads, identity recheck, signature validation and SHA-256. Only ENOENT is missing; permission/format/capacity errors are not.
- [ ] Verify no network path, device or reparse traversal; use the caller's capacity, not a second arbitrary image quota. Embedded data accepts validated image data URLs; no remote fetch.
- [ ] Run resolver and snapshot tests; checkpoint changes.

```ts
expect(await resolveImageAttachment({type:'local_image',path:absent}, options))
  .toEqual({state:'missing'});
expect(Buffer.from(result.imageUrl.split(',')[1]!, 'base64')).toEqual(pngBytes);
```

## Task 3: Native persistent import

Modify src/estimation/observer-persistent-worker.ts, src/estimation/observer-persistent-session.ts and their existing tests. Consume Task 1 parts and Task 2 resolution. Extend append records with optional ordered native content; existing `{ordinal,text}` remains compatible.

- [ ] Add RPC-boundary tests asserting native input_image parts, ordered interleaved text, image-only records, replay without re-injection, same-path changed bytes rejecting source rewrite, and partial acknowledgement preventing cursor advance.
- [ ] Confirm RED then extend append fingerprint/capacity/acknowledgement logic. Strip local paths from provider serialization. Frame source metadata once and avoid duplicating text projection. Never split image base64 as text fragments.
- [ ] Resolve records before sending, include encoded image bytes in source accounting and retain existing cancellation/generation/session ownership guards. Preserve missing markers at their original position.
- [ ] Run persistent worker/session and resolver tests, then checkpoint changes.

```ts
expect(injected.content[1]).toEqual({type:'input_image',image_url:pngDataUrl});
expect(session.status().cursor).toBe(-1); // failed acknowledgement
```

## Task 4: Eligibility, identity and visible warning

Modify src/observer/history-snapshot.ts, src/observer/context-owner.ts, src/observer/conversation-source.ts, src/estimation/observer-contract.ts, src/estimation/observer-scheduler.ts and relevant status/UI consumers located through representation references. Add integration coverage to existing scheduler/context-owner/HUD tests.

Interface: representation carries a missing-image count and explicit inference eligibility; sourceComplete remains false when content is missing. A single shared eligibility predicate permits only missing images, never unknown payloads or unreadable records. Propagate quality through compression and result application.

- [ ] Write tests that missing-only context reaches an estimate with warning, missing plus unsupported payload does not; warning survives compression, replay and result application.
- [ ] Confirm RED, implement quality propagation and update contract refinements without falsifying sourceComplete. Ensure image-only instructions and changed image digests alter validity fingerprints.
- [ ] Render “部分历史图片缺失” with ETA and diagnostics. Clear only after corrected/rebuilt context. Non-persistent consumers must reject unsupported image delivery explicitly.
- [ ] Run affected integration/UI tests and typecheck; checkpoint changes.

```ts
expect(eligible({gaps:['missing_image']})).toBe(true);
expect(eligible({gaps:['missing_image','unsupported_payload']})).toBe(false);
```

## Task 5: Whole-chain verification and installation

- [ ] Add one synthetic source-to-RPC integration test proving actual image bytes arrive after a native checkpoint, and missing-file warnings remain observable. Check diagnostic/receipt output does not contain fixture path or base64.
- [ ] Run full tests with one worker, typecheck, build and diff check; retain exact outputs and revision. Review the complete diff with gpt-5.6-sol / medium, then one scoped fix review if needed.
- [ ] Build verified candidate from the tested revision. Ask for disable only when replacement requires it; preserve user data and verify installed file inventory.
- [ ] Observe normal authorized runtime for an accepted ETA and correct end-of-turn behavior. Existing three successful synthetic tests satisfy only their documented scope. If image compatibility needs a separate real call, obtain fresh consent first.

## Execution record

User approved the written spec. Execute in the existing isolated repair worktree; tightly coupled source/import/quality work stays local, final review is delegated under the user model policy. No further design approval is needed for these steps. Tests and installation remain pending.

### 2026-09-13 first implementation checkpoint

- Verified existing linked worktree `feat/persistent-eta-session`; baseline history snapshot suite 46 passed.
- Two new ordered/image-only tests failed with unsupported_payload before implementation, then passed after adding ordered contentParts to snapshot normalization and dedupe.
- Two existing unknown-payload tests used malformed input_image as their unknown sentinel; changed them to future_attachment, and separately asserted malformed images remain unreadable_record blockers.
- Focused suite now 50 passed; TypeScript noEmit and git diff --check passed.
- Task 1 still needs embedded image and changed-image dedupe coverage. Tasks 2–5 remain pending.
- IMPORTANT: this is an uninstalled intermediate patch. The parser now retains references, but the worker does not yet resolve or natively send them. Do not package or enable this source revision until Tasks 2–4 integrate image transport and quality fencing.

### Attachment resolver checkpoint

- Added resolver tests first: missing module was followed by a typed placeholder and 10 observed behavioral failures. Implemented local regular-file reads, ancestor symlink checks, realpath comparison, before/after identity checks, encoded-size bounds, canonical embedded data URLs, signature/MIME checks and sanitized error codes.
- Existing PNG bytes round-trip unchanged. Absent files alone return missing; directories, network/device-like paths, unsupported bytes, capacity errors and cancellation do not.
- Added junction-ancestor rejection, changed-byte digest, embedded source image and duplicate-versus-changed replay coverage. Two focused files now contain 64 passing tests. A test-only indexed-access type error was found and corrected; rerun typecheck before claiming a clean milestone.
- Resolver is not wired into production import yet. Additional format/permission/race coverage and security review remain required. Signature checking is not full image decoding; provider compatibility remains unverified. Do not install this intermediate revision.

### Native image transport checkpoint

- Added and observed RED for native session import ordering/replay and ambiguous acknowledgement; implemented native content append with content-inclusive hashes, encoded capacity, compaction admission and cursor commit only after an empty-object acknowledgement.
- Added and observed RED for worker image transport; worker now resolves source parts and sends input_image alongside ordered text. Local attachment paths are excluded from metadata serialization; the text projection is not duplicated.
- Four focused suites passed: 122 tests. Typecheck and diff check passed. The worker integration fixture was subsequently strengthened to include an actual synthetic native checkpoint; rerun its focused case.
- Missing-file branch deliberately remains an explicit IMAGE_MISSING error until Task 4 adds eligibility plus the required model/UI warning atomically. This is NOT the approved final behavior, and must not be packaged as completed.
- Remaining: missing-only eligibility without sourceComplete falsification; warnings through compression/results/UI; image-aware current-turn fingerprints; nonpersistent-path handling; local-file-to-worker and capacity/cancellation coverage; final review, full regression, installed runtime verification.

### Missing-image behavior checkpoint

- Observed worker RED with IMAGE_MISSING, then replaced absent-file failure with an ordered missing-image marker and explicit missingImages/sourceGaps/inferenceEligible metadata. sourceComplete stays false and mode incomplete when images are missing.
- Observed scheduler/UI RED, then added the shared isInferenceEligible predicate and context_images_missing diagnostic/ETA label. Missing-only prepared context proceeds; missing plus unsupported_payload remains blocked. Source preflight still blocks unrelated original history gaps.
- Six focused suites passed 173 tests. Typecheck identified the separate ContextRepresentation interface missing new fields; synchronized it and require final typecheck below.
- Known remaining warning-lifetime issue: contextState is overwritten during the next preparation, so the warning currently needs separate durable quality state to remain visible while the prior estimate is shown. Do not declare Task 4 complete yet.
- Still no packaging, real model calls, or completion claim. Image-only live projection, image fingerprints, nonpersistent consumers, durable warnings, native import capacity/cancellation, review and installed runtime remain pending.

### Warning lifetime checkpoint

- Added separate turn-scoped missingImages quality to scheduler diagnostics instead of relying solely on transient contextState. UI reads this quality during context_preparing and other transient states. Reset/new-turn boundaries clear the old turn's quality; an eligible newly prepared full context clears its missing count.
- UI and scheduler tests first failed on missing quality/label, then passed. Added a real two-dispatch scheduler test: missing-image result, deferred second preparation retaining warning, full preparation clearing it. Test fixture needed a refreshed source tick and trigger delay before the second dispatch; after correction it passed.
- Scheduler/UI suites passed 51 tests before the added two-dispatch test; that additional test passed separately. Typecheck passed before that last test edit; rerun at next checkpoint.
- Still uninstalled and unreviewed. No model calls. Next critical work: live source image-only readiness and identity, nonpersistent-path rejection, remaining image transport limits/format coverage, then full regression and review.

### Live image identity checkpoint

- Added RED source tests for image-only readiness, changed-image instruction/content fingerprints, and bounded projection without raw base64. Implemented imageCount/imageFingerprint metadata, image-aware instruction and content identity, and projection-only image placeholder for scheduling. Actual image data still comes exclusively from full history preparation.
- Added RED live-reader test and now compute bounded image metadata for live parsing; full snapshot retains ordered parts. This avoids holding base64 in the persistent live projection.
- Added RED stateless context-preparation test; it now explicitly rejects image-bearing history instead of returning text-only full context.
- Four affected suites passed 109 tests; typecheck passed. Snapshot imageCount/fingerprint must not be treated as proof that local file bytes still match: worker resolution/replay checks cover import time, but in-flight local-file mutation fencing needs further inspection.
- Remaining direct-path safety: scheduler workers without prepareContext must not receive an image-only projection as if it contained image data. Add explicit projection image-pending metadata and reject unsupported direct dispatch; persistent preparation must clear it only after successful native import.
- Still pending transport cap/cancellation and format/permission coverage, security/session review, full regression and installation. No real inference was performed.

### Direct dispatch guard and milestone run

- Added imageContextPending on scheduling projections; native worker clears it only after successful history import. Scheduler rejects unresolved image context with image_context_unsupported, including workers with no prepareContext. Added static HUD diagnostic wording.
- Focused no-preparer test passed after fixing its fixture timing: initial constructor read had already captured the old batch; source refresh and enough trigger delay were required to actually exercise image dispatch. Typecheck passed.
- Started full suite, one worker/no file parallelism: exec session 25150, node PID 48364, start 2026-09-13 approximately 20:48 HK. It is running; resume this exact handle with write_stdin, do not restart because output is quiet.
- Remaining capacity concern found by inspection: persistentHistoryPolicy currently only carries requestBytes into the text frame limit; native image append uses the total context allowance. Propagate an explicit whole-native-request byte bound before release, and test encoded RPC overhead. No implementation claim for this gap yet.

### Request budget and review checkpoint

- Added observed RED for request limit propagation and native full-frame rejection. Propagated nativeRequestByteLimit from configured requestBytes through worker/session; all inject requests include conservative JSON-RPC envelope/newline sizing before dispatch. Default respects the existing 16MiB transport ceiling.
- Added cancellation-during-ack test: native cursor stays uncommitted and session uncertain. Session/policy tests: 30 passed; typecheck passed.
- Full test session 25150 remains running on last poll; continue exact handle. Since production edits occurred after suite start, this run is not a frozen-final-revision verification; affected suites must run after changes and final milestone rerun may be required.
- One read-only gpt-5.6-sol/medium review dispatched for the entire uncommitted feature, including resolver; no real inference authorized or requested. Capture returned agent id from tool output and await findings before additional production edits.
- Reviewer: Fermat `01a09ad2-5766-79e2-a09a-a4d51d3b4b6e`. Build also running: exec 82489. Full-suite last poll still live with SQLite experimental warnings, no terminal result. Preserve these exact handles across continuation.
- Build 82489 completed exit0. Read-only current-source scan using built code:369tail records, images0 in tail, coverage complete/nogaps. Does not prove checkpoint images absent or provider image compatibility.
- Full-suite25150 still live, now reports failure in tests/integration/full-context-estimation.test.ts, unsupported-history test (malformed input_image with path field). Final failure details pending. Reviewer notified; do not rewrite the assertion or restart the suite. Reviewer has not returned final findings yet.
- Full-suite25150 subsequently completed exit1:197files passed/1failed;2437tests passed/1failed;369.93s. Failure is harness.refresh throwing source_malformed from live reader before scheduler assertion. No need to poll25150 again. This suite began before request-cap edits; those were separately focused-tested. Review still pending.

### Review fixes in progress

- Recovered the original interrupted Sol/medium reviewer rather than creating another seat. It returned five actionable findings: attachment result freshness, local-image provenance, Windows open/reparse race, durable image-presence metadata, and capacity rejection before compaction. Candidate remains uninstalled.
- Reproduced the malformed-image regression, then kept live projection readable while full snapshot still blocks malformed history. Two suites passed 58 tests before the additional provenance cases; afterward 61 passed.
- Added observed RED provenance tests and restricted local_image reads to non-conflicting native user messages. Unsupported live parts retain an explicit pending marker; full snapshot retains a blocking gap.
- Added observed RED projection-eviction and pre-compaction-capacity tests; implemented sticky per-source image delivery metadata and whole request validation before model compaction. Three suites passed 67 tests.
- Added observed RED same-path mutation tests before dispatch and after provider completion. A bounded local-only manifest now revalidates resolved digests and missing state. Stale interpretations are rejected and the session invalidated, while known token usage remains settled. Explicit pending/ineligible context is blocked at worker admission too.
- Added observed RED quality consistency tests and tightened shared eligibility/schema checks. An older worker test expected inference for an unsupported source gap; changed its assertion to invalid_input and zero starts, matching the approved fail-closed rule. Two suites passed 41 tests.
- Added synthetic source-file -> snapshot -> resolver -> native RPC integration, including a checkpoint, exact bytes/order, and receipt/path leakage assertions. Added compaction/replay/new-turn missing-quality lifecycle and corrected-file rebuild checks. Both passed; these use a local fake provider, not real inference.
- Added observed RED stateless checkpoint-image rejection and cancellation-after-result accounting tests; both now pass. Typecheck passed before the Windows helper test was added; the later typecheck reports that not-yet-created helper module, so no final typecheck claim yet.
- Windows resolver implementation delegated to Locke 01a09ade-7d6c-71c3-9c46-a27b90939c5c, luna/high, write scope resolver/helper/focused tests only. No extra model or account calls. Final scoped Sol fix review remains available once all edits settle.
- Full suite 52277 was started prematurely while helper tests were being edited, then intentionally stopped with Ctrl+C (exit1). It is NOT verification evidence and must not be resumed. Run final full suite only on the frozen integrated implementation.

### Integrated verification and installation gate

- Windows helper handed off with native exact-path no-reparse opening, handle attributes, read-only sharing and one-shot hidden subprocess. Helper code is embedded in TypeScript and included by the normal build; no external asset or persistent image cache is added.
- The same scoped Sol fix review accepted the original main-scope and native-open fixes by inspection, but identified stale preparation after process/binding replacement and helper cleanup ownership. No extra review seat was created.
- Observed RED for process closure and binding changes between prepare/observe; both now reject the stale prepared object with zero ETA admission, then succeed only after re-import. Prepared identity is local WeakMap metadata, not a provider field.
- Final review's remaining P2 cleanup issue was corrected locally with observed RED lifecycle tests: both pipe errors request termination, cancellation/timeout wait for close, a two-second cleanup deadline marks unconfirmed ownership, and replacements stay blocked until that original close event. No claim of confirmed cleanup is made at the deadline.
- Full suite 98589 completed exit0: **200 files / 2,468 tests passed**, 367.87s, started 21:26:58 HK. Its file discovery preceded the final helper lifecycle patch and two new tests, so it is not described as a frozen post-cleanup suite.
- After the last cleanup patch, all affected worker/resolver/helper files were re-run together: **4 files / 68 tests passed**, 22.41s. This includes the two new lifecycle tests. TypeScript noEmit, build and git diff --check also passed after the patch. This full-suite plus affected-suite combination is the installation gate evidence; no untested production changes are included.
- User confirmed HUD disabled; read-only process check returned no HUD processes. Candidate build and exact inventory installation remain next. Preserve user data. No model calls were added during implementation; the earlier three real synthetic inheritance results remain separate evidence, not image compatibility or accuracy evidence.
