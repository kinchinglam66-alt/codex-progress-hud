# Native foreground compression removal: implementation and test record

Status: implementation, Series32 and fresh frozen-code full regression complete. Not merged, pushed or installed.

## Changes

- Completed-turn native sessions defer actual capacity handling to the runtime. The plugin no longer initiates repeated compaction from conservative byte thresholds in that route, including inline supplements. RPC/source-size bounds remain; unknown resident size is reported as unverified, not a measured guarantee.
- Scheduler no longer silently falls back from an unavailable native pair to full-history import. The old comparison/import machinery remains for legacy modes and reproducible baseline tests; it is not a native fallback.
- Accepted requests have a 30-second deadline covering source preparation and inference. Timeout aborts the signal and publishes timeout state, rejects late results, and keeps cleanup/accounting ownership until work finishes. Paired source cleanup is awaited before settlement/release. A subsequent request clears the old timeout state.
- Ready first observations no longer wait 15 seconds or initial event coalescing. Later cooldown and ordinary cadence remain unchanged. Source readiness delay and remote-service success cannot be guaranteed; this is not a promise of a valid number within 30 seconds of every user keystroke.
- Necessary runtime automatic compaction remains accounted for; missing usage never becomes zero.

## Verification

TDD:79bd42 exposed proactive compaction and fallback;6e41f2 exposed missing deadline; b9a7cd exposed initial wait. Review regressions f5d3da reproduced delayed source cleanup, persistent timeout label and inline capacity policy. Corrections passed253 focused tests10fc31; worker136 tests passed003bd2 with real Windows ACL/process permissions. The automatic compaction preservation parameterization passed89 tests649b6f (subsequent inline test brings that file to90).

Independent Sol/medium review Arendt: three findings corrected, one fix review returned no findings. No repeated review/model trials. Build374590 exit0 for build; its preceding test invocation was not green, so do not cite the combined shell exit as passing tests.

Full sweep87852/2c5c33:260 files,3249 tests,3245 passed/4 failed,566.81s. Three new review regression tests were introduced while the sweep was running and exercised its older loaded implementation; those files subsequently passed. The remaining recovery-E2E fixture advanced simulated wall time before an asynchronous admission denial drained, an assumption exposed by removing the initial delay. Drain-before-clock-advance correction passed all10 recovery tests325d06. A fresh uninterrupted final full sweep remains required for release.

## Series32: three valid returns below30 seconds

Registered private artifact path `.superpowers/sdd/2026-09-15-completed-turn-native-base/series32-registration.md`. One1MiB synthetic history, independent HUD account, Luna medium standard;3 ETA, no retries, no real history. Preflight084042 passed with zero model calls. Runner77465/9b68ec finished exit0. Authoritative result `series32-native/comparison-result.json`; numeric extractionfd0e88.

| Slot | Preparation seconds | Delivery seconds | Known tokens | Cached input included | Reused child |
| --- | ---: | ---: | ---: | ---: | --- |
| Initial |9.043|23.277|123863|0|No|
| Same turn |6.427|13.354|124438|122624|Yes|
| New turn |7.204|23.101|123839|0|No|

All3 returned interpreted ETA under the prospective30-second target, with no source mutation. Budget eta3/compaction0/inFlightfalse/stoppedfalse; ledger starts3/activeStarts3/inFlight0/unresolved0/known372140/unknown0/poisonedfalse. Final cleanup confirmed and errors empty. Cached tokens are part of input, not additive usage or verified monetary savings. No ETA accuracy claim: synthetic tasks were not executed to completion.

The existing paired qualification fields correctly remain `candidatePassed:false` / `requires_three_valid_matched_pairs`: this native-only diagnostic does not supply history/native pairs. Its successful absolute-latency result is separate and does not waive or relabel Series31's failed relative-performance gates. Three samples cannot guarantee every future remote result within30 seconds.

Frozen-code full sweep70833/2b3c2a finished exit0:260 files /3249 tests passed,506.74s, start17:55:25 Hong Kong time. No production edits during this sweep. This is the clean full regression evidence, superseding the mixed earlier sweep for the current implementation. Typecheck and runner syntax checks0b44c1 also passed; independent fix review had no findings. Merge/push/install remain separate user-owned release actions.

Local supplement readback849ccf: all three exact (5/6/3 frames). Automatic compactions0, unexpected model operations0. Readback proves persisted input identity, not independent capture of the remote wire payload. The synthetic semantic marker checks supply separate context-use evidence.

Build identities recorded096a75: session F7168EB9B6F8643C8E666156E371F9BA76737F57797DD36E4CB350B70600302E; worker AFF8810A7751BBA38271367F858E2751829042B6A16DE8441BDBB60549CA2C41; scheduler89578088520670D0B808D113278D862385ED0EA4BF79B1AA2BE7A3F798514926; diagnostic runner1D18CC1C773F4FBBED15A5BDD96DAB2B3C95A24A92687380890B2624BE1B41DF. Installed configuration, credentials and original usage ledger unchanged.
