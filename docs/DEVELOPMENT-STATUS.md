# Development status — 2026-09-07

The main development line includes passive multi-conversation observation,
isolated model-based goal interpretation and ETA, durable usage accounting,
countdown presentation and explicit failure diagnostics. Public main-model
reporting tools and their reporting skill have been removed from this candidate.

## Verification boundary

- Local Windows regression:124test files,1456tests passed; typecheck, build,
  plugin synchronization, manifest/Hooks validation and package contract passed.
- Installed checks established independent estimator activation, accepted numeric
  predictions and a frozen active-work clock after a scoped tracking pause.
- Tracking controls do not pause or terminate the underlying Codex task.
- A new user turn can resume tracking; a task-level pause is not the global
  plugin disable switch.
- Multi-conversation numeric isolation/resume and representative long-task accuracy
  still require measured acceptance. No long-task accuracy claim is established.
- Do not present model uncertainty percentages as calibrated confidence intervals.

## Source update, not release certification

No new release tag, installer publication or signing claim accompanies this source
update. Existing installation documentation may describe the earlier release;
follow the release checklist before distributing a new candidate as production-ready.
The approved runtime list is intentionally finite: unknown binaries remain rejected
even when their reported version matches a known version.

Private positioning notes, local authentication/configuration, raw live-session
records and scratch output are not public repository inputs. Retain research
evidence locally and publish only explicitly reviewed, de-identified datasets.
