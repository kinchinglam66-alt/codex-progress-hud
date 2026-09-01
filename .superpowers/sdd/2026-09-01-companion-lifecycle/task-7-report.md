# Task 7 Report: Sanitized diagnostics and bounded logging

## Outcome

Implemented category-only operational logging with canonical timestamps, runtime field projection, event-code allowlisting, serialized writes, and bounded file rotation. Diagnostic Markdown now exposes only versions, lifecycle state, `%APPDATA%`-relative existence labels, host/port, runtime age, categorized errors, and safe verification commands while returning the absolute report path. Manager and desktop boundaries record startup, shutdown, conflict, mismatch, and recovery categories without payloads. The tray Diagnose seam now creates the safe report.

The production retention policy is three files at 1 MiB each. Rotation tests use three files at 256 KiB each.

## TDD evidence

- Initial diagnostics RED: `npm test -- --run tests/diagnostics` exited 1. `logger.test.ts` failed because `src/diagnostics/logger.ts` did not exist; `report.test.ts` failed because `%APPDATA%` labels and safe commands were absent.
- Initial manager integration RED: `npm test -- --run tests/lifecycle/companion-manager.test.ts` exited 1 with 6 expected logging failures and 16 existing tests passing.
- Initial desktop integration RED: `npm test -- --run tests/desktop/lifecycle.test.ts` exited 1 with 10 expected logging failures and 17 existing tests passing.
- Canonical timestamp RED: `npm test -- --run tests/diagnostics/logger.test.ts -t "date-like prose"` exited 1 because `September 2, 2026` was accepted. After requiring exact `Date#toISOString()` form, the logger suite passed 4/4.
- Prescribed GREEN: `npm test -- --run tests/diagnostics tests/lifecycle tests/mcp` exited 0 with 8 files and 77 tests passing. The first combined attempt exposed only a 5-second fixture timeout; reducing the real-I/O fixture from 9,000 to 6,000 entries retained more than three 256 KiB windows and completed in 2.86 seconds.
- Desktop boundary GREEN: `npm test -- --run tests/desktop/lifecycle.test.ts` exited 0 with 27/27 tests passing.
- Full suite, run once: `npm test -- --run` exited 0 with 16 files and 165/165 tests passing.
- Final logger verification: `npm test -- --run tests/diagnostics/logger.test.ts` exited 0 with 4/4 tests passing.
- `npm run typecheck` exited 0.
- `npm run build` exited 0.
- `git diff --check` exited 0.

## Redaction and rotation mutation checks

All mutations were temporary and restored exactly before final verification.

1. Added an `...entry` spread to the logger projection. The targeted test exited 1 and showed the bearer token, command output, environment value, prompt, source path, task ID/title, and arbitrary metadata as unexpected fields.
2. Disabled the rotation branch. The targeted 256 KiB test exited 1: only `companion.log` existed instead of the bounded active file plus two archives.
3. Appended `JSON.stringify(input)` to the report. The report test exited 1 on `super-secret-token` and displayed the injected private fields.
4. The pre-mutation and post-restoration diff hashes both equaled `2f46d457bceb253a89a814313a97af23d1a7dff8`; the restored targeted set then passed 53/53 tests.

## Files

- `src/diagnostics/logger.ts` — strict operational event schema and bounded rotation.
- `src/diagnostics/report.ts` — sanitized Markdown and safe commands.
- `src/lifecycle/companion-manager.ts` — manager lifecycle categories and report delegation.
- `src/desktop/lifecycle.ts` — current desktop implementation boundary, safe Diagnose action, and category logging.
- `tests/diagnostics/logger.test.ts` — type/runtime redaction, event/timestamp validation, and 256 KiB rotation.
- `tests/diagnostics/report.test.ts` — report allowlist, path labels, commands, and absolute output path.
- `tests/lifecycle/companion-manager.test.ts` — startup/shutdown/conflict/mismatch/recovery integration.
- `tests/desktop/lifecycle.test.ts` — desktop startup/shutdown/failure and tray Diagnose integration.

`src/desktop/main.ts` remains the existing re-export because Task 5 moved the implementation seam into `src/desktop/lifecycle.ts`; a no-op re-export rewrite was removed during self-review.

## Self-review and concerns

- The logger TypeScript contract rejects arbitrary object-literal metadata, and runtime projection drops extra fields received through untyped JavaScript boundaries.
- Event values are allowlisted; timestamps must be canonical ISO strings; no free-form message or metadata field exists.
- Logger failures are best effort and cannot change Task 3 lifecycle outcomes or Task 5 cleanup obligations.
- Existing explicit-off, crash cooldown, bounded startup/shutdown, forced-termination ownership, and executable-mode tests remain covered by the passing targeted and full suites.
- No unresolved validation or privacy concern.

## Fix round 5

### Root cause and outcome

The remaining Important finding was the lock protocol's separate identity path. `readLockRecord` used default numeric pathname and handle stats, `LockRecord` allowed `number | bigint`, and temporary-owner cleanup plus `unlinkIfOwned` returned to default numeric pathname stats. On Windows, distinct 64-bit device/inode values can round to the same JavaScript numbers, so those guards could accept a different lock or owner file.

Lock identity is now bigint end to end. The lock pathname precheck and post-read check use the existing internal `FileSystemOperations.lstatBigInt` seam, the opened lock handle uses `handle.stat({ bigint: true })`, `LockRecord.device` and `.inode` are fixed `bigint`, and temporary-owner recording, failed-publication cleanup, stale recovery, release, and every `unlinkIfOwned` check use the same bigint seam. Token validation, owner pipes, hard-link atomic publication, and release ordering are unchanged. No public product API was added.

### TDD and collision evidence

- Deterministic RED on unchanged commit `0bafb0e`: `npm test -- --run tests/diagnostics/output-races.test.ts -t "distinct bigint identities collide as numbers"` exited 1 because `logger.write` resolved instead of rejecting. The failure was behavioral, not a type or fixture error.
- The fixture supplies four distinct bigint path/handle/owner identities whose device values all convert to one numeric value and whose inode values all convert to one numeric value. It retains real directories, files, handles, hard-link publication, writes, and cleanup while injecting only exact stat identities through the round-4 internal seam.
- Under the fixed code, the lock path/handle mismatch is rejected before log content is written. Failed-publication cleanup then compares two different exact owner-file identities and preserves the file rather than unlinking a numerically colliding replacement.
- The unchanged-HEAD RED is the precise rollback proof: restoring the prior numeric implementation makes the same test resolve successfully. After the bigint fix, three focused runs passed identically (the initial GREEN plus two repeat runs).
- A production-source search found no remaining default numeric lock identity stat and no `Number(dev)` or `Number(ino)`. Remaining numeric handle stats in logger rotation are bounded file sizes and write offsets, not identities.

### Verification

- `npm test -- --run tests/diagnostics/output-races.test.ts tests/diagnostics/logger.test.ts` — 2 files, 21/21 tests passed.
- `npm test -- --run tests/diagnostics` — 3 files, 41/41 tests passed.
- `npm test -- --run tests/lifecycle tests/desktop tests/mcp tests/integration/companion-lifecycle.test.ts` — 11 files, 122/122 tests passed.
- Three consecutive `npm test -- --run --reporter=dot` runs — each passed 18 files and 210/210 tests.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `git diff --check` — exit 0 before this report update; repeated in the final commit gate.

### Files changed and concerns

- `src/diagnostics/logger.ts` — bigint lock records and exact stat usage throughout the lock lifecycle.
- `tests/diagnostics/output-races.test.ts` — deterministic numeric-collision lock/owner regression fixture.
- `.superpowers/sdd/2026-09-01-companion-lifecycle/task-7-report.md` — this evidence.

The previously accepted Node pathname-create residual remains unchanged: a same-user directory replacement in the final kernel-call gap can leave an empty exclusively created artifact, but content is withheld until exact post-open validation succeeds. No new unresolved Task 7 concern was found.

## Fix round 4

### Root cause and outcome

The gate failure had two distinct causes, and the closer production cause was more specific than the original module-cache hypothesis:

1. The race fixture depended on a hoisted global `vi.mock("node:fs/promises")`. A temporary loading-order probe imported `report.ts` before registering `vi.doMock`; the report completed but the replacement `open` was never called (`intercepted === false`). This confirmed that the old interception mechanism depended on module evaluation/cache order. The probe was removed and is not part of the committed suite.
2. After replacing that mock with an explicit injected `open`, the directory-substitution test still deterministically resolved. Instrumentation showed two different live Windows directories receiving the same default numeric inode. A standalone 128-directory probe found a concrete collision: numeric inode `12103423999402556` represented distinct bigint file IDs `12103423999402556` and `12103423999402557`; `Number.isSafeInteger` was false. The post-open directory check therefore compared rounded 64-bit Windows file IDs and could accept a substitution.

The internal diagnostics filesystem seam now carries real `lstat(..., { bigint: true })`, `mkdir`, `open`, and `realpath` operations. Production `writeDiagnosticReport` and `createOperationalLogger` compose it with the real Node operations; their existing public signatures and the package entry API are unchanged. Internal composition functions let race tests inject an `open` wrapper while retaining real directories, files, handles, lock publication, writes, rotation, and cleanup. Directory/path/handle/link identities in `safe-files.ts` are compared as bigint values, eliminating the observed precision collision.

### RED and GREEN evidence

- Loading-order evidence probe: `npm test -- --run tests/diagnostics/module-cache-probe.test.ts`
  - Exit 1 as intended: expected the late mock to intercept, received `false`; the real report write completed.
- Seam RED: `npm test -- --run tests/diagnostics/output-races.test.ts`
  - Exit 1 before implementation with `createDiagnosticReportWriter is not a function`, proving the requested internal composition boundary was absent.
- Behavioral RED after the seam was first wired with numeric identities:
  - 5/6 race tests passed; `rejects a directory substitution before report content is written` resolved instead of rejecting.
  - Exact instrumentation identified the rounded Windows inode collision described above.
- Focused GREEN after bigint identity comparison: `npm test -- --run tests/diagnostics/output-races.test.ts`
  - Exit 0; 6/6 tests passed.
- Shared-cache-order GREEN: `npm test -- --run tests/diagnostics/output-races.test.ts tests/diagnostics/report.test.ts --no-isolate`
  - Exit 0; 26/26 tests passed.

The committed race fixture has no global core-module mock. It asserts that the explicit injected `open` boundary is reached, verifies that the two replacement directories have different exact bigint identities, requires rejection before report content is written, and inspects the real outside directory to ensure any exclusively created residual file remains empty. Existing hard-link, handle-based rotation, outside-content preservation, and successor-lock tests continue to use real filesystem behavior.

### Mutation evidence

The mutation was temporary and restored before final verification.

- Removed only the post-open `assertTrustedDirectory(directory, fileSystem)` call from `verifyOpenedFile`.
- Ran `npm test -- --run tests/diagnostics/output-races.test.ts -t "directory substitution"` three independent times.
- All 3/3 runs exited 1 with the same meaningful failure: the promise resolved with a report path instead of rejecting. This proves the explicit seam reaches the intended boundary and the test protects the post-open identity guard rather than merely asserting a test double.
- Restoring the guard returned the focused suite to 6/6.

### Final verification

- `npm test -- --run tests/diagnostics/output-races.test.ts` — 1 file, 6/6 tests passed.
- `npm test -- --run tests/diagnostics` — 3 files, 40/40 tests passed.
- `npm test -- --run tests/diagnostics/output-races.test.ts tests/diagnostics/report.test.ts --no-isolate` — 2 files, 26/26 tests passed.
- Twenty independent `npm test -- --run` stress iterations — 20/20 runs passed, each with 18 files and 209/209 tests. The run was split into 12 and 8 iterations only because the execution tool ended the first command at its wall-time limit; no test failed.
- Final `npm test -- --run` — 18 files, 209/209 tests passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `git diff --check` — exit 0 after the report update.

### Files changed and concerns

- `src/diagnostics/safe-files.ts` — exact bigint identity checks plus the real default filesystem-operation object.
- `src/diagnostics/report.ts` — unchanged public writer composed over the internal filesystem seam.
- `src/diagnostics/logger.ts` — unchanged public logger composed over the same internal seam.
- `tests/diagnostics/output-races.test.ts` — explicit operation injection; no `vi.mock` or module-load-order dependency.
- `.superpowers/sdd/2026-09-01-companion-lifecycle/task-7-report.md` — this evidence.

The accepted Node pathname-create residual from fix round 3 remains: a hostile same-user directory swap in the final kernel-call gap can leave an empty exclusively created artifact, but content is not written until exact post-open validation passes. This round narrows that residual by removing numeric identity collisions. No existing external content, handle-based rotation ordering/bounds, lock behavior, product API, or diagnostic privacy allowlist was changed.

## Fix round 3

### Scope and outcome

Resolved both remaining Important findings:

1. Log rotation no longer deletes or renames any log pathname. It opens and verifies the active file and all existing archive files first, exclusively creates only missing archive files, then copies newest-to-oldest and truncates only through those verified handles. The `maxFiles === 1` path also truncates its already-verified active handle. Three-file bounds, newest-to-oldest ordering, and preservation across archive gaps remain covered.
2. Lock metadata is now fully initialized in a unique owner file before an atomic hard-link publishes `.companion.log.lock`. A random process-instance named-pipe identity, created before publication and held for the process lifetime, replaces PID ownership. Contended recovery is serialized by a directory-derived kernel named-pipe mutex; only a lock whose owner pipe is unreachable is reclaimed. Release re-reads the published record and requires matching token, owner identity, device, and inode before unlinking, so a displaced old owner cannot remove its successor.

### RED evidence

- `npm test -- --run tests/diagnostics/logger.test.ts tests/diagnostics/output-races.test.ts`
  - Exit 1; 2 test files failed, with 6 failed and 11 passed tests.
  - The logger wrote while a suspended live owner was present, wrote through a successor lock, and wrote while a child-process owner was still alive.
- `npm test -- --run tests/diagnostics/output-races.test.ts -t "outside"`
  - Exit 1; 3 failed and 2 skipped tests.
  - Deterministic hooks at the former archive replacement, archive move, and `maxFiles === 1` deletion boundaries caused the old implementation to delete or move outside pre-existing fixtures. The observed outside values were `MISSING` at each applicable victim path.
- Early directory-junction versions of the rotation fixture encountered Windows restore failures (`EISDIR`/`EPERM`) in test cleanup rather than product-code assertions. The final RED fixtures directly model pathname resolution changing at each destructive filesystem call: an old `rm`/`rename` invokes the real destructive operation on an outside fixture, while the handle implementation reaches the corresponding `truncate`/`write` seam without touching that outside path.

### GREEN and verification evidence

- `npm test -- --run tests/diagnostics/output-races.test.ts -t "successor lock"`
  - Exit 0; 1 passed and 5 skipped tests.
- `npm test -- --run tests/diagnostics/logger.test.ts tests/diagnostics/report.test.ts tests/diagnostics/output-races.test.ts`
  - Exit 0; 3 files and 40/40 tests passed in 876 ms.
- `npm test -- --run tests/diagnostics tests/lifecycle tests/desktop tests/mcp`
  - Exit 0; 13 files and 160/160 tests passed in 1.17 s.
- `npm test -- --run`
  - Exit 0; 17 files and 207/207 tests passed in 3.70 s.
- `npm run typecheck`
  - Exit 0; `tsc --noEmit` completed without diagnostics.
- `npm run build`
  - Exit 0; `tsc -p tsconfig.build.json && node scripts/copy-assets.mjs` completed successfully.
- `git diff --check`
  - Exit 0; no whitespace errors.
- `rg -n "\\b(rm|rename)\\b" src/diagnostics/logger.ts`
  - Exit 1 with no matches, confirming rotation has no pathname delete/move operation.

### Test files and mutation coverage

- `tests/diagnostics/output-races.test.ts`
  - Deterministically substitutes an outside victim at every former destructive rotation boundary: destination replacement, source move, and single-file active deletion. Outside pre-existing content must remain byte-for-byte unchanged and no outside destination may appear.
  - Suspends the first logger after lock acquisition, displaces its published lock, lets a successor publish and pause, then resumes the old owner. The successor lock must remain until the successor itself releases it.
- `tests/diagnostics/logger.test.ts`
  - Verifies unpublished/partially initialized owner files never become the lock.
  - Verifies a suspended live owner excludes writes, a child-process crash is automatically recoverable, two concurrent loggers preserve both records, and exact archive ordering and bounds hold.
  - The former 6,000-write rotation test was replaced by three deterministic near-limit prefills. It exercises every bounded rotation generation without making validation depend on host filesystem throughput.

Mutation checks represented directly by the RED runs: restoring pathname `rm`/`rename` allows deletion or movement of outside fixtures; restoring pathname deletion for `maxFiles === 1` deletes the outside active fixture; publishing the lock before metadata completion makes the suspended-initialization test fail; PID-only liveness either reclaims a live process instance incorrectly or cannot distinguish PID reuse; unconditional release removes the successor fixture; and removal of kernel owner liveness lets the logger proceed while the crash-test child is alive.

### Files changed in fix round 3

- `src/diagnostics/logger.ts`
- `src/diagnostics/safe-files.ts`
- `tests/diagnostics/logger.test.ts`
- `tests/diagnostics/output-races.test.ts`

### Residual OS/API limitation and privacy assessment

- Node's pathname-only create APIs still cannot atomically bind an open to a previously validated ancestor directory on Windows. During a malicious concurrent directory substitution, exclusive creation can leave an empty newly created file (or component directory) outside the intended location before post-open identity validation rejects it. The implementation does not attempt pathname cleanup after rejection because that cleanup could be redirected to a pre-existing victim.
- This accepted residual cannot overwrite, delete, move, or modify an outside pre-existing file: existing output opens are identity/link-count verified and rotation mutates only already-verified handles; missing outputs use exclusive creation and receive no bytes until post-open verification succeeds.
- A same-user malicious process can still manipulate lock pathnames in the final gap between identity verification and Node's pathname `unlink`; cooperative owners are serialized and token/inode checked, and the deterministic successor test covers displacement before release. Node exposes no unlink-by-handle primitive. Lock files contain only random owner/transaction identifiers, never operational payloads or user data.
- A crash before atomic lock publication can leave one uniquely named, fully sanitized owner metadata file. It is not lock-visible and affects neither live-owner exclusion nor crash recovery.
- No unresolved diagnostic validation or payload-privacy concern was found. Log records retain only the prescribed category fields, and report restrictions from the earlier fix rounds remain unchanged and covered by the full suite.

## Fix round 2

### Scope and outcome

Resolved the three remaining Important findings:

1. Report error history is snapshotted with one validated `length` read and one intrinsic indexed `Reflect.get` per element. The untrusted array's `map` property is never read or invoked, and only validated primitive error fields reach the internal array rendered to Markdown.
2. Output directory creation now walks one component at a time and rejects an ancestor junction/reparse point before creating its child. A trusted-directory capability records the final directory identity; every output open checks that identity before and after opening, then compares the opened handle with the current path and requires `nlink === 1`. Reports retain exclusive creation, and log rotation/destructive boundaries revalidate directory identity.
3. Lock files now carry bounded owner metadata (`pid` plus a random token). A live PID is never reclaimed; a dead owner is moved aside and removed. On Windows, stale-lock inspection/reclamation is serialized by a kernel-managed named-pipe recovery mutex, which disappears automatically if the reclaimer exits abnormally and prevents two reclaimers from deleting a newly acquired live lock.

The five previously addressed Important findings and all three Minor fixes remain unchanged.

### RED evidence

- `npm test -- --run tests/diagnostics/report.test.ts tests/diagnostics/logger.test.ts tests/diagnostics/output-races.test.ts`
  - Exit 1; 3 files failed, 5 tests failed, and 28 passed.
  - The forged Proxy `map` inserted `Bearer secret`; recursive `mkdir` created `must-not-be-created` through the ancestor junction; directory substitution was accepted and wrote a report; and the orphan lock timed out without recovery.
  - The first hard-link race fixture recursively called its mocked `open` and failed with a test-harness stack overflow. The fixture was corrected to use the captured original intrinsic and a pre-existing active file before evaluating product behavior.
- `npm test -- --run tests/diagnostics/output-races.test.ts -t "hard link"`
  - Exit 1; 1 test failed and 1 was skipped.
  - The write resolved instead of rejecting, proving the opened handle did not re-check its link count after the pathname precheck.

### GREEN and verification evidence

- `npm test -- --run tests/diagnostics/report.test.ts tests/diagnostics/logger.test.ts tests/diagnostics/output-races.test.ts`
  - Final exit 0; 3 files and 33/33 tests passed.
- `npm test -- --run tests/diagnostics tests/lifecycle tests/desktop tests/mcp`
  - Exit 0; 13 files and 153/153 tests passed.
- `npm test -- --run`
  - Exit 0; 17 files and 200/200 tests passed.
- `npm run typecheck`
  - Exit 0.
- `npm run build`
  - Exit 0.
- `git diff --check`
  - Exit 0.

### Test files and mutation coverage

- `tests/diagnostics/report.test.ts`
  - A Proxy reports a forged length of one over an empty target, exposes a forged `map` that returns `Bearer secret`, and changes element zero after its first read. The report contains only `AUTH_ERROR`; `map` has zero reads; `length` and element zero each have exactly one read.
  - An ancestor junction with a missing requested child is rejected and its target remains empty.
- `tests/diagnostics/output-races.test.ts`
  - A deterministic filesystem-boundary substitution moves the validated final directory and replaces it with a junction immediately before the real pathname open. The operation rejects before writing Markdown content outside the trusted directory.
  - A deterministic hard link inserted after the active-log precheck is detected from the opened handle's `nlink`; the linked file remains empty.
- `tests/diagnostics/logger.test.ts`
  - A lock naming a nonexistent PID is reclaimed and `crash_recovery` is persisted.
  - A lock naming the live test PID excludes the writer until that owner releases it.
  - Existing shared-directory rotation, archive-gap retention, linked-file rejection, strict projection, and 256 KiB bounds remain covered. The rotation fixture timeout is 20 seconds because the added Windows identity checks make the 6,000-write real-filesystem fixture take approximately 9–12 seconds on this host.

Mutation checks represented directly by the RED runs: restoring `errorsInput.map` leaks the forged bearer value; restoring recursive `mkdir` creates the junction target child; removing post-open directory identity validation accepts redirected report creation; removing opened-handle `nlink` validation writes through the raced hard link; and removing owner liveness/recovery reproduces permanent lock timeout.

### Files changed in fix round 2

- `src/diagnostics/safe-files.ts`
- `src/diagnostics/logger.ts`
- `src/diagnostics/report.ts`
- `tests/diagnostics/logger.test.ts`
- `tests/diagnostics/report.test.ts`
- `tests/diagnostics/output-races.test.ts`

### Windows/Node limitation evidence and concerns

- Runtime: Node `v24.14.1` on Windows.
- Read-only probe while holding an open directory handle: `open-dir=ok`, then `rename-while-open=allowed`.
- Read-only probe while holding an open file handle: `hardlink-while-open=allowed 2`.
- `rg -n "openat|FILE_SHARE_DELETE|OPEN_REPARSE_POINT" node_modules/@types/node/fs.d.ts node_modules/@types/node/fs/promises.d.ts` found no directory-relative open or Windows share/reparse control in the available Node API declarations.
- Therefore Node pathname APIs cannot provide a kernel-atomic guarantee against a malicious same-user process swapping a directory or adding a hard link in the final instruction window. The implementation prevents unvalidated content writes by checking directory, path, handle identity, and link count immediately after open; an adversarial swap can at worst leave an empty exclusively-created file outside the trusted path before rejection. It deliberately does not pathname-delete that file after detecting a directory swap, because another swap could redirect the cleanup deletion to an unrelated file.
- Operational logs and diagnostic reports contain only the fixed sanitized allowlists even under this residual OS/API race. No task envelope, prompt, token, source path, command output, environment value, or arbitrary metadata can reach either output body.

## Fix round 1

### Scope and outcome

Resolved all seven Important review findings and all three Minor findings:

1. Logger entries snapshot every permitted property exactly once before validation and projection, preventing getter/Proxy time-of-check/time-of-use substitution.
2. Diagnostic reports snapshot and validate canonical timestamps, bounded numbers, version syntax, lifecycle/error enums, booleans, bounded error history, and loopback host/port before creating files. Display values are Markdown-escaped and the PowerShell health URI is built only from validated loopback endpoint values.
3. Manager and desktop logging are fire-and-forget with synchronous-throw and rejection containment. Permanently pending loggers cannot delay startup, shutdown, cleanup, or quit.
4. Every logger instance uses the same exclusive `.companion.log.lock` file before stat/rotate/append, so separate manager/desktop processes serialize the shared rotation set.
5. Output directories are resolved and verified against `realpath`; junctions/reparse redirects are rejected. Existing output files must be single-link regular files, append handles are identity-checked, and reports use exclusive `wx` creation without truncation. Directory junction and file hard-link redirection tests run without elevated Windows symlink privileges.
6. Report directories are resolved before creation and the returned report path is always absolute. Existing timestamp filenames receive an exclusive numeric suffix and are never overwritten.
7. Tray Diagnose receives a sanitized live desktop snapshot based on current visibility/quitting state, measured runtime age, and the last ten classified desktop errors. It no longer treats runtime-file presence as lifecycle truth.

Minor fixes record actual desktop startup completion time/elapsed milliseconds, preserve older archives across an intermediate archive gap, and use shared `PROTOCOL_VERSION` throughout manager diagnostics/logging.

### RED evidence

- `npm test -- --run tests/diagnostics/logger.test.ts tests/diagnostics/report.test.ts tests/lifecycle/companion-manager.test.ts tests/desktop/lifecycle.test.ts`
  - Exit 1.
  - 4 files failed; 26 tests failed and 54 passed.
  - Failures covered repeated getter reads, invalid report fields, relative path return, junction report/log output, existing report overwrite, pending logger startup/shutdown/cleanup, zero elapsed time, stale Diagnose state/errors, and archive-gap deletion.
- `npm test -- --run tests/diagnostics/logger.test.ts -t "shared directory lock"`
  - Exit 1.
  - The active log changed while `.companion.log.lock` was held, proving the original implementation had no cross-instance serialization protocol.
- Initial privileged file-symlink fixtures failed during setup with Windows `EPERM`, before product code ran. They were replaced with unprivileged hard-link redirect fixtures.
- `npm test -- --run tests/diagnostics/logger.test.ts tests/diagnostics/report.test.ts -t "linked.*file"`
  - Exit 1.
  - 2 tests failed because the logger wrote through a linked active file and the report writer accepted a linked predictable filename.

### GREEN and verification evidence

- First focused GREEN attempt left only 2 compatibility failures out of 81 tests: `AUTH_ERROR` was over-escaped as `AUTH\_ERROR`, and the pre-existing one-clock-call assertion conflicted with real elapsed timing. Narrowing escaping to injection metacharacters and updating the timing assertion resolved both.
- `npm test -- --run tests/diagnostics/logger.test.ts tests/diagnostics/report.test.ts tests/lifecycle/companion-manager.test.ts tests/desktop/lifecycle.test.ts`
  - Exit 0; 4 files and 83/83 tests passed.
- `npm test -- --run tests/diagnostics tests/lifecycle tests/desktop tests/mcp`
  - Exit 0; 12 files and 148/148 tests passed.
- `npm test -- --run`
  - Exit 0; 16 files and 195/195 tests passed.
- `npm run typecheck`
  - Initial exit 1 identified only a Node `Stats` number/bigint overload and widened test-spy types.
  - Final exit 0 after explicit numeric narrowing and typed `vi.mocked` access.
- `npm run build`
  - Exit 0.
- `git diff --check`
  - Exit 0.

### Files changed in fix round 1

- `src/diagnostics/safe-files.ts`
- `src/diagnostics/logger.ts`
- `src/diagnostics/report.ts`
- `src/lifecycle/companion-manager.ts`
- `src/desktop/lifecycle.ts`
- `tests/diagnostics/logger.test.ts`
- `tests/diagnostics/report.test.ts`
- `tests/lifecycle/companion-manager.test.ts`
- `tests/desktop/lifecycle.test.ts`

### Fix-round self-review and concerns

- Task 3 desired/observed lifecycle behavior remains unchanged; logger settlement is removed from lifecycle control flow.
- Task 5 cleanup remains concurrent and bounded; pending logging cannot consume its cleanup timeout.
- Task 6 executable-mode behavior remains covered by the passing desktop/MCP and full suites.
- Log/report content still has no free-form message, payload, title/ID, prompt, token, path, command output, environment value, or arbitrary metadata field.
- No unresolved validation or privacy concern.
