# Single-owner main-account session preparation

## Objective

Remove the duplicate ephemeral account metadata process and remote authentication from a cold main-account ETA preparation. Preserve complete effective conversation context, the 30-second ETA deadline, account-change fencing, consent, usage accounting and confirmed cleanup. A faster local test is not proof of end-to-end latency.

## Decision

Use the persistent worker as process owner from startup. During identity preparation, the trusted identity runtime may request a transport through a request-scoped callback. The worker starts and initializes its own isolated process, creates its fixed-account refresh lease, and subscribes to unexpected-work notifications. The identity reader attests route and remote account on this transport. Its returned attestation identifies that exact transport. After desktop consent/binding validation, the worker continues with the already authenticated transport instead of starting another process.

This supersedes the tentative transfer-of-ownership design. Returning a live process from a metadata owner would add unclaimed-process expiry, timer transfer and dual-close races. Skipping remote identity verification or using cross-request cached main-account evidence is rejected.

## Contract

Add a dedicated main-account-session-transport type module. `MainAccountSessionTransport` contains `rpc`, `lease`, `pid`, `creationIdentity`, and `invocation`; the worker owns its lifetime. `OpenMainAccountSession` is `(invocation: Invocation, signal: AbortSignal) => Promise<MainAccountSessionTransport>`.

`SessionPreparationPolicy.openMainAccountSession` is optional and trusted-only. It is supplied only by a fixed main-account worker preparing a new process. Identity settings inspection, independent-account preparation, API providers and existing retained-worker preparation keep their current behavior. The callback never returns credentials, nor persists them.

The metadata reader accepts this optional callback. Without it, the reader retains its existing isolated process and close-on-return behavior. With it, the reader uses the returned initialized transport and fixed lease; it does not initialize twice, create another lease, or close a successful borrowed process. On cancellation/failure it closes the RPC promptly; the worker still joins process closure through reset. A callback transport whose invocation or account binding differs must be rejected before authentication.

The reader returns the exact attested transport reference with metadata. Identity/runtime preparation forwards it only after home/preflight, route/account/source and consent/binding checks succeed. The worker must compare reference identity, process identity, invocation, lease and account binding with the transport it opened; absent or mismatching attestation rejects the operation. No fallback to a second process after a partially created transport.

## Lifecycle invariants

1. Worker ownership exists before any asynchronous metadata use. One creator, one close owner; settings-only inspection still closes its own process.
2. Subscribe to unexpected model work before initialization/authentication. No thread/turn/history operation occurs until metadata, consent and durable owner receipt pass.
3. Source account change invalidates lease, aborts request, invalidates reuse, and disables process. Refresh cannot move a request to another account.
4. Failed home recheck, consent change, cancellation, callback failure, route mismatch, missing transport attestation, receipt-write failure and unexpected work all reach worker reset. Failed cleanup poisons the worker and retains necessary evidence.
5. Initialize and remote authentication occur once per newly adopted process. Returned prepared transport must not be reused by a different request or owner. Existing healthy retained processes follow their existing validation path.
6. Keep request-scoped proof validation, source/turn/ticket fences and delivery validation. Independent account behavior remains unchanged. No cross-request main-account cache.
7. Capture/journal the actual PID and creation identity before context import or model admission. Usage and unknown-usage handling stay unchanged.

## Verification

Use local fake app-server processes to count actual initialization, metadata authentication and inference RPCs. Test normal first request, following request, retained process, account/source/consent changes, cancellation before/during callback and after metadata, wrong route/transport, unexpected model notification and failed close. Assert process closure and accounting, not only callback invocation counts.

One independent authentication/ownership review, focused tests while implementing, full frozen serial suite at the installation milestone, then fresh build/package/hash verification. Installed real timing includes trigger wait, preparation, import, inference and delivery; record cold and warm cases separately. Preserve private history and credentials outside source control. Do not claim the 30-second objective from one accepted result or from request duration alone.
