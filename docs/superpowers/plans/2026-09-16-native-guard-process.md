# Native guard process implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline as requested by the user.

**Goal:** Reuse a local verifier process without reusing security conclusions.
**Architecture:** Fixed home-bound read-only helper, strict transport, resource-owned retirement. Existing one-shot behavior remains default until qualification.
**Tech Stack:** TypeScript, Windows PowerShell, Vitest.
**Spec:** docs/superpowers/specs/2026-09-16-native-guard-process-design.md

## Global constraints

Fresh checks per request; no credentials, models, network, arbitrary commands or external process termination in the helper. Input 256 bytes; output 1024 bytes; request 6s, idle 30s, close confirmation 5s. Unknown close poisons the owner. Keep source/custody/ledger protections and original end-to-end gates. User now authorizes design adjustments without repeated approval. No automatic installation or publication.

## 1. Strict protocol and process transport

Files: src/estimation/native-guard-protocol.ts, native-guard-transport.ts and matching tests.

- [ ] RED: encode verify/owner requests, reject extra/duplicate fields, wrong IDs/operations, invalid identity and oversized frames.
- [ ] GREEN: export `encodeNativeGuardRequest(id, request): string` and `decodeNativeGuardResponse(line, id, op): 'ok'|'exited'|'live'`.
- [ ] RED/GREEN: process reuse still requires a new reply; busy rejection preserves owner; cancellation/timeout/invalid output waits for close; unconfirmed close forbids replacement; old frames cannot resolve a new generation.

```ts
expect(encodeNativeGuardRequest(1,{op:'verify_storage'})).toBe('{"v":1,"id":1,"op":"verify_storage"}\n');
expect(()=>decodeNativeGuardResponse('{"v":1,"id":1,"id":2,"op":"verify_storage","result":"ok"}',2,'verify_storage')).toThrow();
```

Run each test file using `D:/node.exe node_modules/vitest/vitest.mjs run <file>` before and after implementation.

## 2. Fixed Windows helper and trusted launch

Files: scripts/windows/native-guard.ps1, src/estimation/native-guard.ts, matching real Windows tests.

- [ ] RED/GREEN: verify prepared protected home, then alter ACL between checks and require failure; verify live, exited and reused PID identities against owned processes.
- [ ] Implement fixed launch-home, strict bounded ASCII input, exact output fields and allowed results. Port existing fresh native-storage and invocation-process checks, not their cached results.
- [ ] Validate script hash and non-link ancestry on every request. Test changed launch asset, home isolation and protocol rejection with real helper.

```ts
await guard.verify(signal);
expect(await guard.isExited(ownedIdentity,signal)).toBe(false);
await guard.retire();
```

## 3. Resource lifecycle integration

Files: native-worker-resources.ts, native-observer-trial.ts, matching resource tests.

- [ ] RED/GREEN: opt-in verifier shared by storage and identity checks; default remains one-shot.
- [ ] Release uses finally to retire after allocation/copy/registration/cleanup drains. Retain unresolved ownership on cleanup failure; poison on unconfirmed helper close; normal retirement permits a later fresh generation.
- [ ] Cancellation reaches active checks; cleanup retains independent bounded lifetime. Test both success and failure releases and separate-home resources.

## 4. Review and qualification

- [ ] Focused tests, one security review and at most one fix review; preserve RED/GREEN evidence.
- [ ] Full suite, typecheck, build and diff check at milestone (commits deferred until verified).
- [ ] Three alternating real-guard benchmark pairs including cold start/close, no models.
- [ ] Synthetic matched ETA trials under existing authorization; preserve all failures and original 85KiB/1MiB gates. Report local, cleanup and end-to-end costs separately.

Self-review: protocol, launch trust, freshness, lifecycle, cancellation, custody, candidate-only rollout and performance gates each have an explicit task. No implementation agents or additional approval gate.
