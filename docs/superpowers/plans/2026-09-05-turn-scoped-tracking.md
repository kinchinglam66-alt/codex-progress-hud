# Turn-scoped tracking implementation plan

> **For agentic workers:** Use superpowers:executing-plans for the tightly coupled integration in this existing isolated worktree. Use test-driven-development for every behavioral slice.

**Goal:** Track distinct turns without reopening completed records or redirecting stale results.

**Architecture:** Introduce a bounded pure turn router before integrating the changed Hook identity contract. The router produces a scoped progress envelope plus provenance/selection decisions. HTTP applies those decisions atomically with authorization and revision checks; terminal reducers remain unchanged.

**Tech Stack:** TypeScript, Zod, Vitest, Node MCP/HTTP, Electron.

**Spec:** `../specs/2026-09-05-turn-scoped-tracking-design.md` (approved in this conversation).

## Global constraints

- Keep connection-owned lifetime, explicit off, authenticated loopback, bounded deadlines and generation checks unchanged.
- No transcript polling, prompt storage, credential changes, Hook trust bypass, telemetry or paid model requests.
- Terminal protection remains within each turn, including verified success, failure and interruption.
- Preserve bounded previous-turn summaries using existing 32-record/15-minute retention limits initially.
- Missing turn identity is degraded, not permission to infer a current turn.
- User routing: focused implementation luna/medium, complex work luna/high, one final risk review sol/medium; no repeated review agents by default.
- Do not build or install a mixed protocol package. Installed-host acceptance follows a safe exit/install/reopen cycle.

## Task 1: Pure routing boundary

Files: create `src/server/turn-router.ts`, `tests/server/turn-router.test.ts`.

Consumes existing `HookEnvelope`; produces `TurnRoute`:

```ts
type TurnRoute =
  | { kind: 'ignored'; reason: 'duplicate' | 'expired_turn' }
  | { kind: 'degraded'; reason: 'turn_identity_unavailable' | 'turn_order_unknown' | 'turn_capacity_reached' | 'turn_identity_conflict' }
  | { kind: 'session'; sessionKey: string; ended: boolean }
  | { kind: 'apply'; envelope: ProgressEnvelope; sessionKey: string; turnKey: string;
      follow: boolean; lateAttached: boolean; orderingUncertain: boolean };
// createTurnRouter({maxTurns?: number, retentionMs?: number}) returns
// {route(envelope: HookEnvelope, observedAt: number): TurnRoute,
//  observeTerminal(taskHandle: string, observedAt: number): void,
//  hasIdentity(taskHandle: string): boolean}
```

- [ ] Write real-routing tests and observe red. Handcrafted fixtures use different literal task/turn handles, not the production HMAC helper for expectations.

```ts
const router = createTurnRouter();
expect(router.route(promptA, 100)).toMatchObject({kind:'apply', follow:true});
expect(router.route(promptB, 200)).toMatchObject({kind:'apply', follow:true, orderingUncertain:true});
expect(router.route(stopA, 300)).toMatchObject({kind:'apply', follow:false});
expect(router.route(unkeyedStop, 400)).toMatchObject({kind:'degraded', reason:'turn_identity_unavailable'});
```

- [ ] Implement bounded Maps keyed by immutable task association. Retain per-record session/turn identity, last accepted receipt time and current-session selection. Use server observation time for retention, not sender timestamps. Reject future receipt times and malformed limits. Do not let older/duplicate events move selection. Stop/Interrupt with unknown turn cannot create a task.
- [ ] Route UserPromptSubmit to turn_started, PostToolUse to activity_seen, Stop to turn_stopped, Interrupt to runtime_interrupted; return attachment provenance separately. SessionStart/SessionEnd remain session observations.
- [ ] Cap identity tombstones and fail closed on capacity instead of evicting live fencing state. Expired records remain non-reopenable until router lifecycle reset; explicit capacity-degraded state exposes the tradeoff.
- [ ] Run `npx vitest run tests/server/turn-router.test.ts`, then typecheck. The router remains unconnected until Task 2 is complete.

## Task 2: Hook identity, store and HTTP/MCP integration

Files: `src/hooks/schema.ts`, `src/server/task-store.ts`, `src/core/types.ts`, `src/core/schema.ts`, `src/server/http-server.ts`, `src/mcp/tools.ts`, `src/mcp/report-client.ts`; tests under `tests/hooks`, `tests/server`, `tests/mcp`.

- [ ] Write identity regression tests before changing HMAC domains:

```ts
expect(turnA.envelope.taskHandle).not.toBe(turnB.envelope.taskHandle);
expect(turnA.envelope.sessionKey).toBe(turnB.envelope.sessionKey);
expect(turnA.result.hookSpecificOutput?.additionalContext).toContain(turnA.envelope.taskHandle);
expect(unkeyed.result.hookSpecificOutput?.additionalContext).not.toContain(unkeyed.envelope.taskHandle);
```

- [ ] Derive turn handles from domain-separated session+turn identity. Unkeyed events receive invocation identity only; no writable turn context is emitted. A retry reuses the same envelope.
- [ ] Add optional internal turn metadata to records and summaries; preserve it only through authenticated Hook routing. Do not accept arbitrary client metadata as authorization.
- [ ] Invoke the router inside the existing guarded Hook mutation after revision/lease checks. Apply only routed envelopes; store bounded source diagnostics for degraded/session results. Route observation time and event receipt time separately.
- [ ] Add selection eligibility so an update to a known old turn cannot steal follow mode. Preserve pin/hide semantics and in-memory record bounds.
- [ ] Reject immutable-terminal MCP updates explicitly (`EVENT_NOT_APPLIED`) and recognize that code in the MCP client. Do not silently map a legacy handle to the newest turn.
- [ ] Real integration regression: create A via Hook, bind its MCP lease, verify A, create B via Hook and bind B, send late A events, assert B remains running with no inherited verification/ETA. Test missing identity, duplicates, crossed leases and explicit off.
- [ ] Run Hook/router/store/HTTP/MCP tests, typecheck and rebuild compiled stdio before integration tests.

## Task 3: Presentation and compatible packaging

Files: `src/ui/view-model.ts`, `src/ui/renderer.ts`, `src/desktop/tray-controller.ts`, `src/mcp/report-client.ts`, `config/release-capabilities.json`, generated capabilities, plugin skill/descriptions and packaging fixtures.

- [ ] Add view-model tests: grouped current/prior turns, identity-unavailable text, absent ETA remains unavailable. Do not display raw grouping identifiers.
- [ ] Extend strict snapshot validation for optional grouping/provenance fields and test malformed values.
- [ ] Advance protocol current/minimum/maximum together to 2; Hook schema version 2. Verify v1 writes rejected with mismatch diagnostics. Synchronize root/nested plugin artifacts via existing generators, not installed-cache edits.
- [ ] Update usage instructions to consume the freshly injected per-turn handle. Preserve supplied handles and never invent/rebind one.
- [ ] Build and run real two-turn packaged smoke alongside existing entry and lifetime smoke; all must finish successfully including cleanup.
- [ ] Full suite, typecheck, build, bounded review and one fix review if needed. Record exact evidence and known limitations before a candidate install.

## Task 4: Installed acceptance gate and downstream sequence

- [ ] Install matched artifacts with user-coordinated Codex exit/reopen and normal Hook trust review where required. Verify real consecutive turns, model updates, prior completion and UI visibility.
- [ ] If host identity is unavailable, expose degradation and record the missing capability; never manufacture a passing result. This blocks automatic-turn acceptance, not further safe mock-estimator development.
- [ ] Continue approved backlog step 2 lifecycle matrix, then step 3 mock estimator using immutable captured turn handles. Steps 4 live inference/data and 5 publication retain explicit provider/budget/data/release gates.

## Execution ledger

- Baseline: ebfa7a0, existing isolated branch fix/hud-diagnostics-paths; focused Hook/store/reducer tests 47 passed. No submodule parent reported.
- Tasks 1–2: core implementation and focused regression tests complete; independent runtime risk review in progress. Session attachment remains connection evidence and does not fabricate work.
- Task 3: protocol 2, strict snapshot fields and UI labels implemented. Full suite: 723/723 tests across 46 files; typecheck/build/local smoke passed on 2026-09-05. Packaged synthetic two-turn Hook/MCP isolation, explicit terminal rejection and handle-free restart passed. Usage skill synchronization and remaining package checks pending.
- Task 4: pending. No installed-host acceptance, replacement, commit, merge or push claimed.
- Regression evidence: explicit terminal rejection broke handle-free restart (new test red, then green); fallback rollover now requires terminal evidence for the exact association. Explicit handles never roll over.
- Retention fence: real HTTP regression reproduced recreation of an evicted turn. Both MCP and Hook entry paths now consult the bounded router identity fence before allowing creation.
- Presentation: current/prior turns share local conversation labels without exposing grouping keys. Historical identity/order/capacity warnings remain visible, including with no selected task.
- Test timing note: the existing 100 ms real-socket lease-deadline test failed during an earlier loaded suite; focused and subsequent full run passed unchanged. Production timeouts were not increased; retain as a known flakiness investigation item.
- Independent sol/medium review found two important issues: Hook terminal/retained no-ops returned success, and receipt ordering dropped distinct delayed Stop/Interrupt events. Four red regressions reproduced them. Hook fencing now returns EVENT_NOT_APPLIED, and delayed scoped terminal evidence is accepted without lowering the receipt watermark. Focused 74 tests and subsequent full 731/731 tests, typecheck/build/local smoke passed.
- Packaged native-launcher and connection-owner acceptance passed before the final HTTP/router fix: two idle owners survived beyond grace, one disconnect preserved the other, final disconnect exited the companion. Rebuilt package checks are required after the final fix.
- Known minor limits: per-turn event capacity 256 also gates terminal evidence; tracking diagnostics are explicitly companion-global historical warnings, not per-conversation evidence. Conversation display numbers are local to the retained snapshot, not persistent identifiers.
- Usage-reference check complete using independent offline luna/medium probes: baseline incorrectly retargeted A's delayed estimate to B; narrowly revised reference keeps A. Root/nested skills synchronized and syntax validated. No paid estimator/provider was contacted.
- Final candidate: full 731 tests, typecheck/build/local smoke, rebuilt two-turn Hook/MCP and native-launcher smoke, connection-owner lifecycle/cleanup, plugin validation and package contract all passed. One sol/medium fix review closed both important findings. Candidate installer generated but not installed; see runtime acceptance report for hashes and remaining host gate.
- Ruling: retain stale identity tombstones within a strict capacity rather than silently forgetting them — replay safety takes precedence over indefinite uptime; capacity exhaustion is visible and requires lifecycle reset. This is not a claim of unlimited-turn tracking.
- Ruling: previously unseen turn order is uncertain without source sequencing — UI may follow the latest accepted prompt but must label ordering uncertainty; exact scoped terminal events never finalize another handle.
- Plan self-review: Task 1 outputs route metadata consumed by Task 2; Task 2 metadata is validated/rendered by Task 3; Task 4 requires all three and matched protocol artifacts. No implementation may claim installed success before Task 4.
