# Interrupted estimator recovery: development checkpoint

Status: first recovery increment implemented and verified; not installed.

## Confirmed failure

A pending reservation from a prior accounting owner prevented new admissions,
while recovery status could still report normal. The HUD also conflated local
admission denial with waiting for quota. This diagnosis alone is not evidence of
a provider rate limit or a failed remote model request.

## Changes under verification

- Distinct local-block diagnostic and bounded reason propagation.
- Recovery guidance in the HUD and settings page, including overdue displays.
- Conservative reconciliation after verified local reboot. Same-boot automatic
  process recovery is intentionally not part of this first delivery.

## Evidence so far

- Existing recovery baseline: 29 tests passed.
- Diagnostic/UI/worker/MCP focused tests: 216 tests passed across eight files.
- An additional real temporary-ledger reopen-to-worker integration test passed.
- Typecheck passed after the initial diagnostic changes.
- New diagnostic cases were first observed failing before implementation.

The first full suite found one built browser-module 404 among 1,924 tests. An
explicit static asset mapping fixed it; the focused authenticated HTTP module
graph test then passed. Review identified an unqualified executable path and an
overbroad recovery reason; both were fixed, with 84 scoped tests passing and a
clean scoped fix review. The final full suite passed: **160 files / 1,929 tests**,
with exit code 0 in 342.92 seconds, using
`npm test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000`.
Typecheck, build, plugin validation and diff checks passed. Node emitted its
existing experimental SQLite warnings; there were no failed tests.

No user ledger was reset, no live estimator inference was requested, and no
installation was replaced during these checks. Development and review agents
still consume their normal Codex usage.

The real Windows boot probe passed outside the restricted sandbox. Inside the
sandbox, CIM access was denied and the probe correctly failed closed. This is
capability evidence, not evidence of recovery of any production admission.

## Intended user flow after verification and installation

When an old invocation cannot be confirmed closed, save work and reboot the
computer. Open HUD settings and run the local recovery check, then confirm one
bounded synthetic trial if offered. This does not require logging in again.
Unknown usage remains unknown; a new successful trial does not reconstruct it.
The plugin must never reboot the computer or terminate unrelated tasks itself.

## Remaining work

- Merge/push/install this verified increment when requested.
- Validate one real recovery after installation; it may require a user reboot.
- Add durable per-invocation process ownership for same-boot automatic recovery.
- ETA accuracy evaluation is separate from this accounting/recovery regression.
