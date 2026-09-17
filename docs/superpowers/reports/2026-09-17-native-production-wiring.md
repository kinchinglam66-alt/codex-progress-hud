# Native production wiring

The native latency experiments did not themselves enable the installed desktop
route. This release connects the existing completed-turn source to the desktop
subscription worker, with same-turn child reuse, inline current-turn supplements,
resident home validation and the hash-pinned native guard. API mode is unchanged.

The native runtime is restricted to the exact previously qualified build. An
incompatible runtime must fail subscription startup, not advertise readiness and
fail only on the first scheduled worker acquisition. No account credential,
provider consent or ledger reset is part of this migration.

The scheduler's 30-second deadline covers accepted estimation requests, not an
unconditional promise of a valid remote response within 30 seconds of user input.
Late responses are rejected; owned process cleanup and accounting remain awaited.
Unavailable native context is not silently converted to full-history import.

The Windows package includes native-guard.ps1 and preserves its LF bytes on Git
checkout so its pinned SHA-256 remains valid. Installation replaces only companion
program files. Plugin launcher and Hooks do not require changes.

## Verification record

- Factory wiring and runtime-contract regressions: red before the wiring, green
  afterward. Unauthorized observation starts no preparation/model process.
- Typecheck, build, local service smoke, manifest validation and package contract
  passed before final regression.
- Original three synthetic latency results remain historical evidence, not
  production end-to-end or ETA accuracy measurements.
- Final regression, review and installation verification are recorded at release
  completion; raw local test histories and account data are excluded from Git.
