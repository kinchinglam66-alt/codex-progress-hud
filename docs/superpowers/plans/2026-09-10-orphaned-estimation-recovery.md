# Orphaned Estimation Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track steps below.

**Goal:** Stop misleading quota messages and recover old pending calls safely after a verified reboot.

**Architecture:** Preserve the existing exclusive ledger and recovery controller. Introduce a conservative reboot closure boundary before reconciliation, not automatic clearing on process startup. Follow with same-boot invocation ownership in a separate increment.

**Tech Stack:** TypeScript, Node SQLite, Windows PowerShell, Vitest.

**Spec:** docs/superpowers/specs/2026-09-10-orphaned-estimation-recovery-design.md

## Global Constraints

- Do not modify real user accounting data or request live estimator inference during development.
- Preserve unknown usage and cumulative starts; missing usage is not zero.
- Never terminate unrelated Codex processes or reboot the computer automatically.
- Keep concurrency, authorization, account binding and recovery trial budgets.
- Use one Luna high implementation pass and one Sol medium final review, with at most one fix review.

### Task 1: Visible local admission blocks

**Files:** src/estimation/observer-worker.ts, subscription-session.ts, observer-provider.ts, observer-scheduler.ts; src/core/observer-diagnostics.ts; src/ui/view-model.ts; their focused tests.

**Interfaces:** Optional `admissionReason` on the subscription/provider result, a bounded string enum. Local admission denial renders `admission_blocked`, not provider quota exhaustion. Accounting recovery admission adds `unresolved_previous_call` in Task 2.

- [x] Add a real scheduler test returning a denied local result and assert the diagnostic is not rate limited.
  ```ts
  expect(scheduler.diagnostics(key)?.state).toBe('admission_blocked');
  ```
- [x] Run focused tests and record expected failure.
- [x] Carry whitelisted reasons from recovery admission through result to scheduler, with generic local-block fallback for an unknown reservation refusal. Render local recovery guidance in the view model.
  ```ts
  if (lastResultStatus === 'admission_denied') state = 'admission_blocked';
  ```
- [x] Run scheduler, worker, protocol and UI tests; preserve existing actual hourly/concurrency diagnostic behavior.

### Task 2: Conservative post-reboot reconciliation

**Files:** src/estimation/release-accounting.ts; accounting-worker-{protocol,owner,entry}.ts; new src/estimation/recovery-boot-boundary.ts; src/desktop/observer-runtime.ts and observer-recovery.ts; focused accounting/recovery tests.

**Interfaces:** Add a typed unresolved-previous-call reason to recovery admission and status. Add an owner reconciliation operation accepting a trusted boot-boundary proof obtained by the runtime, never renderer-supplied. Exact proof type must carry a verified operating-system boot timestamp and bound observation time; reject missing, future, stale and non-integer evidence.

- [x] Reproduce reopen with pending: ordinary reserve remains blocked and recovery status must not be normal.
  ```ts
  const id = await first.forConversation('fixture').reserve();
  await first.close();
  const second = await open(path, clock);
  expect(await second.forConversation('other').reserve()).toBeNull();
  expect(second.recoveryStatus().state).toBe('blocked');
  ```
- [x] Test a verified boot after old admission, same-boot denial, unavailable boot evidence, two pending calls and repeat reconciliation. Use temporary databases only.
- [x] Implement Windows boot inspection with bounded hidden PowerShell, strict parsing and conservative timestamp ordering. No wall-clock-minus-uptime heuristic. Unsupported platforms fail closed.
- [x] In an exclusive serialized transaction, reconcile only recovered admissions whose admission predates the verified boot boundary. Mark usage unknown and preserve counters; clear recovered occupancy only after commit. Do not grant ordinary admission before the existing explicit bounded recovery flow succeeds.
- [x] Wire the trusted check to recovery preflight behind authorization/account binding and scheduler closure. Keep old records blocked before reboot. The ordinary runtime must never accept a proof from a settings request.
- [x] Test successful recovery trial, failed trial, process close failure, disable, persistence failure, restart and unchanged known-token history. Reuse the existing trial limit and cooldown rather than adding unlimited probes.

### Task 3: Review and delivery checkpoint

- [x] Run focused integrations, `npm run typecheck`, `npm run build`.
- [x] Run `npm test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000` once at milestone. Final: 160 files / 1,929 tests passed after correcting the first run's browser module 404.
- [x] Have Sol medium review accounting/authorization, proof provenance, idempotence and UI reason propagation. Fix findings and run affected tests.
- [x] Record results and remaining same-boot ownership work. Do not claim a live recovery or install without actually performing it.
