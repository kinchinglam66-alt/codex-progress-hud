# Reusable home-check executor

## Approval and scope

User approved the formal chat design on 2026-09-16 after the zero-model feasibility spike. This document specifies that design for review before implementation. Candidate defaults off. No installation, release, change to model authorization or relaxation of the native-base acceptance gates is included.

The existing native-base goal remains: immutable completed-turn base, fresh child per ETA, complete current-turn prefix at a fixed watermark, and ETA for the current turn only. This component removes redundant local process startup; it does not replace account inspection or change context semantics.

## Ownership and interfaces

Add a desktop-private reusable home-check executor owned by one `createObserverIdentityRuntime` instance, bound to its immutable home profile. No process-global pool and no sharing across independent account runtimes. Existing one-shot route remains the default.

Separate `checking`, `resident`, `closing`, and `poisoned` states. A resident idle helper is not an active model call, not an unresolved inference and not a reason to reject preparation. It remains owned and must be confirmed closed when the identity runtime closes. A closing helper is not eligible to receive requests or be replaced until closure is confirmed.

The executor exposes `check(verifyOnly:boolean, signal:AbortSignal):Promise<string>`, `retire():Promise<void>`, `close():Promise<void>` and `status():{checking:boolean;resident:boolean;closing:boolean;poisoned:boolean}`. `retire` drains/closes the current generation without permanently disabling later generations; `close` permanently disables the owner. Concurrent checks are rejected rather than multiplexed or queued without bounds. This does not introduce a global cap on parallel ETA calls.

## Security checks

Every request repeats existing host-side independent-home resolution, canonical path/type checks, script size/stability/hash verification and credential file metadata validation. Every helper request repeats current SID, owner, protected ACL, allowed principals, directory ancestry/reparse checks, entry limit, prohibited config and credential ACL checks. No previous successful result is reused. Do not cache account checks or extend their existing TTL.

Extract reviewed validation logic into an explicit function used by one-shot and persistent modes; do not perform the spike's runtime string replacement. Ship pinned source bytes and update packaging pin tests. Bind the parent directory at launch; protocol requests cannot supply a path, executable, script, arbitrary command, credential content or account data. Continue using hidden, direct child process launch without a shell.

Maintain the current documented limitation: path checks alone do not defeat same-user/admin path replacement races. New code must not claim stronger containment or omit current checks.

## Protocol and lifecycle

Use versioned JSON-line requests containing exactly a monotonically increasing safe integer request ID and the fixed prepare/verify operation. Responses contain the matching ID and strictly validated existing result fields. Requests are bounded to 256 UTF-8 bytes; responses to 4096 bytes. Reject wrong/duplicate IDs, extra fields, malformed UTF-8/JSON, unsolicited output, stderr, oversized frames and premature process exit. No result from an older generation may settle a new request.

Each request keeps the existing 10-second check timeout. Idle helpers retire after 30 seconds without a request. Cleanup has a 5-second bound; request failure, cancellation, disable, identity invalidation and login/logout transitions retire the process. Confirm the actual close event; on unconfirmed exit retain ownership and poison the runtime. Do not silently spawn a replacement or accept a late response. EOF when the parent closes stdin causes helper exit. Normal idle retirement may start a fresh generation on a later request only after confirmed closure.

Do not reuse the one-shot `createOwnedProcessRunner` unchanged: it closes stdin at dispatch and resolves only at process close. Use a dedicated bounded executor rather than altering unrelated model/login supervision semantics.

## Integration

Add an optional default-false runtime option for reusable checks. `perform` and `validateLocalIdentity` retain their before/after checks but acquire checks from the same runtime-owned executor when enabled. End of a successful check releases only request activity; it does not disable a healthy resident helper. Cancellation and invalidation retire the generation. `close` awaits operations and executor closure, and rejects unconfirmed ownership. Existing one-shot mocks cannot establish these semantics; use the real executor with controlled child transport in integration tests.

The account RPC, runtime executable pin/version checks, identity-file snapshots, generation fences, source custody, consent, ledger and result acceptance rules stay unchanged. Apply the same option to both history and native-base routes in comparisons; do not optimize only the candidate's account preparation.

## Verification and rollout

1. Test cold/warm reuse, exact IDs, frame bounds, request timeout, cancellation, idle retirement, close failure, unexpected exit and late-generation events using controlled child streams and fake timers.
2. On Windows, verify real protected synthetic directories twice, then mutate ACLs, config, credentials metadata, path and script and require rejection. Verify-only must not create or repair state. Never use real credentials for these tests.
3. Exercise identity runtime preparation, local guard and acceptance with a resident helper. Test invalidation, account/login transitions and full close. Keep one-shot tests passing.
4. Verify script hashes, package assets, typecheck, build and full regression at a milestone. Account/authentication ownership changes require focused release-risk review, without claiming earlier reviews cover this work.
5. Repeat zero-model timing with cold start, warm requests and total lifecycle. Then compare both ETA strategies with the same candidate setting under the existing synthetic evaluation rules. Retain all failures and unknown usage.

Existing gates still require at least three valid matched pairs for both 85KiB and 1MiB, at least 30% complete-preparation median improvement, no first-valid-delivery median regression, no unexplained token/warm regression, content/isolation correctness and non-increasing full lifecycle total. Local helper timing alone proves none of these overall gates. Installation stays unchanged until separately approved and gates satisfied.
