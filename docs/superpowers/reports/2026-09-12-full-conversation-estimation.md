# Full-conversation estimation implementation validation

Status: implementation and offline verification complete on the isolated feature
branch (`625ce1d`, before this report commit). This is not a release, installation, or ETA
accuracy result. The installed application and user login/configuration have not
been modified by this implementation phase.

## Implemented scope

- Source-backed readable-history snapshots from the authenticated conversation,
  including history preceding HUD attachment; bounded lifecycle state is separate.
- Lossless estimator task text, strict full/compressed/incomplete metadata, current
  turn ETA horizon, and pinned instructions treating old history as untrusted data.
- Model-scoped explicit capacity configuration, capacity-triggered old-history
  compression, current evidence retention and bounded in-memory summary reuse.
- Subscription/API compression adapters, provider-generation preparation guards,
  snapshot cancellation and diagnostic states without raw task text.
- Safe size/call-count journal metadata and updated data-processing disclosures.

## Focused evidence so far

The controller independently ran these focused checks during implementation:

| Scope | Result |
| --- | --- |
| Snapshot/source acquisition | 11 tests passed |
| Capacity/configuration and provider host | 52 tests passed |
| Settings, provider configuration and host | 71 tests passed |
| Context preparation, UI, MCP, journal, pins and host (combined milestone) | 174 tests passed |
| Strict full-context input, planner, wrapper and scheduler | 30 tests passed |
| Prompt pins, identity and API assets | 18 tests passed |
| Plugin source/package synchronization | Passed |
| Controller fresh integration/scheduler fixtures | 15 tests passed |
| Subscription session, exact task-text transport | 30 tests passed |
| Fresh typecheck/build/plugin validation | Passed |
| Isolated Windows packaged smoke outside sandbox | Passed |
| Final full suite (177 files, 399.04 seconds) | 2,162 tests passed; zero failures |

These runs overlap and must not be added together as a unique test count. The
final full suite includes all implementation corrections. Fresh typecheck, build,
plugin synchronization/validation and final rebuilt packaged smoke also passed.

## Resolved integration issues

The initial slices exposed remaining cross-module contracts: the old process stdin
cap, compression-purpose propagation through threaded accounting, source-loading
clock revalidation and stale preparation diagnostic writes. These are part of the
current implementation, not evidence of successful installed acceptance. Their
targeted corrections are committed through `8f7273b`. An older subscription
fixture expected task-text redaction; it now asserts exact synthetic source text
and still verifies that accounting logs do not contain that text (`1cd49f5`).

The normal package command could not download Electron under restricted network
access. Using the already-installed Electron distribution produced the isolated
package. Its sandboxed GUI launch timed out; the same package outside the sandbox
passed MCP-first startup, authenticated visible health, passive controls, restart,
and synthetic two-turn Hook isolation. This is not an installed upgrade.

## Review and final validation

One independent architecture/accounting review identified a hidden 16 MiB process
budget ceiling and unbounded snapshot deduplication metadata. Both were reproduced
with failing regressions and corrected: trusted positive safe-integer process
budgets remain enforced on actual stdin, while snapshot metadata uses a bounded
hashed window with explicit incomplete coverage after eviction. Later text is not
discarded. The single fix review reported no important findings. Focused affected
checks passed (37 tests), followed by a passing typecheck.

The first full run reported 2,157 passed and three failed; those failures retained
the superseded redaction/16 KiB-packet assumptions. Updated contract checks passed
individually. The fresh final full run passed all 2,162 tests across 177 files
(start 2026-09-12 15:40:06 local, duration 399.04 seconds). The first run is not
counted as all-green. Final rebuilt packaged smoke also passed.

## Measurement interpretation

Original-text size counters exclude protocol overhead. Prepared-request counters
include the supplied route-specific serialization. Token estimates are labeled by
sizing method; conservative sizing is not measured provider usage. Compression
call counters count planner adapter invocations, not confirmed remote billing.
Accounting must preserve unknown usage instead of reporting it as zero.

All model results in this phase use synthetic fixtures. No real model benchmark,
new paid probe, installed upgrade, merge or remote push has been performed. These
checks cannot establish semantic summary fidelity, long-task ETA accuracy or
provider network reliability. Separate real-task evaluation remains necessary.
