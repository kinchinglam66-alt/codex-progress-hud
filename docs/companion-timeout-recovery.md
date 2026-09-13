# Companion request timeout is not a crash

## Confirmed defect

The manager previously mapped an identity or authenticated-health request timeout
to `crashed` when a runtime record existed. `ensureRunningOnce` then logged a
crash recovery and consumed its cooldown. If observation consumed the operation
deadline, startup immediately failed without having time to spawn anything.

A timeout does not establish process exit. A live instance can later answer
without a replacement. This also means a failed snapshot request alone must not
be described as a desktop crash or an ETA reset.

## Narrow repair

- Represent request timeouts as `unresponsive` with existing `START_TIMEOUT`.
- Return the bounded failure without starting or terminating a companion.
- Do not consume crash recovery cooldown on this path.
- A subsequent healthy observation reuses the instance; a subsequent offline
  observation retains the existing recovery policy.
- Diagnostic sanitizers accept the new observational state.

No consent, credentials, model settings, accounting, ETA algorithm, or stored
research data are modified. No global timeout extension or automatic retry loop
is added.

## Verification and remaining work

Two regression cases cover identity and health timeouts, later healthy reuse,
and later real offline recovery. Both failed before the repair. Related
lifecycle/diagnostic/integration suites passed 200 tests; TypeScript passed.
Independent review identified shutdown-handoff and diagnostic wording omissions;
three additional failing regressions were added and repaired. The final unchanged
tree passed 2,222 tests across 190 files, TypeScript and build checks. The earlier
in-flight full run overlapped the deliberate red-test stage and is not the final
verification result. No installation, merge or push was performed in this repair.

This is NOT a fix for the underlying temporary service outage. Before declaring
that symptom resolved, correlate simultaneous health/snapshot request results,
process identity, event-loop delay and bounded CPU profiling during a recurrence.
Distinguish UI visibility, endpoint responsiveness, authenticated snapshot access,
lease shutdown and actual process exit. Preserve observation gaps in ETA scoring;
do not backfill them with later predictions or count snapshot rows as model calls.
