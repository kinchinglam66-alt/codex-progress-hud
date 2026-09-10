# Low-interruption observer and truthful runtime status

## Scope and approval

The user approved the in-chat direction: remember estimation consent, recover from ordinary errors, preserve safety boundaries, and fix idle conversations displayed as running. This document makes the implementation defaults explicit for the architectural written-spec review. No production behavior changes before that review. Work stays in the existing isolated snapshot; it is not a Git checkout, so no automatic commit, merge, or push is possible here.

No new provider, model, paid API route, login method, telemetry upload, or default estimation frequency increase. The existing model remains gpt-5.6-luna with medium reasoning. Do not launch real inference during implementation tests. Installation requires a separately verified candidate and a disabled plugin; no live program replacement during development.

## Confirmed code observations

- observer-consent.ts deliberately starts unapproved at every construction; observer-runtime.ts asks the native consent dialog at every fresh setup.
- observer-runtime.ts currently disables the complete runtime on any identity refresh exception.
- observer-scheduler.ts treats dispatched missing usage as a global disable condition; release accounting independently blocks uncovered unknown usage. Changing only the scheduler cannot implement automatic recovery safely.
- PassiveGoals.observe can transition a waiting goal back to running for a same-turn PostToolUse after Stop. The accepted-router/source-order path must be examined before asserting that this caused the user's particular HUD report.

## Chosen approach and alternatives

Choose persisted scoped consent plus a bounded automatic recovery state machine. Keeping every current prompt does not meet the user's request. Removing admission limits and retrying every error would permit duplicate or unbounded subscription usage and is excluded.

### Persistent consent

Store a versioned, desktop-owned consent record in the HUD data directory, protected using the existing Windows-private storage conventions. It contains no login tokens or raw task text. Bind it to verified account identity, provider/data-recipient identity, approved data categories, subscription billing mode, and consent-policy version.

On restart, re-enable, or compatible application update, silently restore the grant only after fresh identity and runtime validation. Separate short-lived identity attestations from the longer-lived user grant: an attestation timeout suspends dispatch and initiates revalidation, not deletion of the user's consent.

Do not bind consent to a transient proxy node address or every instruction-file hash. A proxy route change that still verifies the same provider/account need not prompt again. Changed account, recipient, data scope, or billing mode requires a new explicit consent. Binary/schema compatibility checks remain independent prerequisites and cannot be skipped using stored consent.

Settings exposes “撤销估时授权”. Revocation invalidates the stored grant and cancels future dispatch; in-flight ownership and accounting must still be closed/settled. Plugin disable suspends operation but retains remembered consent. Removal/revocation behavior must be documented, not inferred from unrelated application settings.

Existing users receive one consent update explicitly explaining remembered authorization and limited automatic retries; the old session-only acceptance must not silently authorize a broader future spending policy.

### Automatic recovery

Classify errors from structured execution outcomes, never error-message substring guesses alone:

1. Not dispatched + closure confirmed + transient environment failure: first and second consecutive failures allow retry after10s and30s. The third consecutive failure opens the5-minute circuit below; it takes precedence over retry scheduling. The earlier120-second third-retry wording was contradictory and is removed, not used to weaken the three-failure cap. Apply existing global/conversation limits before each attempt.
2. Dispatched + process closed + protocol/framing valid + usage unknown: retain unknown accounting and any valid prediction. A single such result warns but does not permanently disable all conversations.
3. Explicit login expiry/revocation, changed identity/scope, failed accounting persistence, corrupt ledger, incompatible runtime, uncertain process closure, or stale ownership: suspend calls; show a specific actionable reason. Never automatically overlap the old process, repair corrupt history, change accounts, or switch to API billing.

Default circuit breaker: three consecutive recoverable failures OR three unknown-usage events in a rolling 60-minute global window enter a five-minute cooldown. Counters/windows must survive restart, conversation switching, and disable/re-enable; ordinary prompts cannot reset them. Known successful results clear the consecutive-failure counter but not rolling historical usage.

After cooldown, allow at most one half-open attempt only if an eligible real task exists, consent is valid, old process closure is proven, and admission budgets permit it. If it fails, use 15-minute then 60-minute cooldown (cap). No autonomous periodic model probing while idle. Show “冷却中” and next eligible time rather than “永久停用”.

Unknown tokens remain unknown, never zero and never silently reclassified as known. The bounded unknown allowance is a separate durable policy decision, not a fake recovery success or an increment to user-confirmed coverage. Existing unknown history and recovery audit records remain intact. Global rolling limits and existing token/admission protections remain in force; reaching a limit must prevent dispatch, including retry and half-open calls.

Network identity refresh may revalidate without inference. It cannot dispatch until the current identity is proven. Refresh retries must be cancellable on plugin disable and serialized with setup/recovery.

### Truthful runtime status

Keep execution state independent from model-estimated goal completion. The independent model may judge whether a whole goal is complete, but cannot declare that the host is still executing after a newer accepted Stop/Interrupt/end event.

Record a per-turn stop barrier. Late PostToolUse or stale model results cannot revive that turn. A genuinely new UserPromptSubmit/new turn or an explicitly verified host resume can establish new execution. Use existing authenticated router/source ordering and turn identity; receipt time alone is not sufficient to override the barrier.

Reconcile missing Stop signals with available same-turn authoritative host/task-source evidence. A final response can support waiting only when no newer running action is evidenced. Silence alone does not mean completed or stopped: long tools and waits are valid. If liveness cannot be established, use “状态待确认”, pause the inferred active-time accumulation at the last trustworthy boundary, and mark the affected time span uncertain for evaluation rather than claiming exact active duration.

Display running only for actually running turns. Preserve the existing exclusion of idle, stopped and completed rows; waiting/paused rows, if shown under current policy, must carry those labels and must not count as executing. No-active-task header must use execution-state counts, not an unresolved goal's existence. An ongoing assistant response in this conversation legitimately counts as active; reproduce the user's idle report at a known idle boundary.

## Implementation boundaries

- Consent persistence and native settings: observer-consent.ts, observer-consent-dialog.ts, observer-runtime.ts, observer-settings.ts, settings renderer/preload and dedicated storage module.
- Recovery policy/accounting: dedicated pure retry policy module, observer-scheduler.ts, runtime recovery boundary, release-accounting.ts and accounting worker protocol/owner. Durable policy mutations serialized through the accounting owner, not UI-side counter resets.
- Runtime truth: passive-goals.ts and authenticated router/context-source/projection boundaries, with only necessary display changes.
- Avoid unrelated ETA formula, prompt, window bootstrap, login, marketplace or main-repository changes.

## Verification and rollout

Use test-first changes and fixed clocks. Test restart/re-enable grant restoration and revocation; account/recipient/scope changes; temporary attestation loss; transient and unknown-result classifications; rolling limits across restart/multiple conversations; cooldown half-open single flight; disable during each retry phase; persistence failure and uncertain closure remain blocking.

Test Stop followed by late same-turn tool event, stale model response after Stop, next-turn prompt, verified resume, missing Stop with final evidence, long silent tool, no trusted liveness evidence, and multiple concurrent conversations. Ensure estimated active time and pause behavior match displayed runtime.

Use one focused implementation pass, one Sol medium security/accounting review, and at most one fix review as specified by AGENTS.md. Routine implementation agents use Luna medium; cross-module/concurrency/accounting implementation uses Luna high. Explicit model and reasoning fields required. Do not create user-visible tasks for subagents.

Run focused tests during each module; full suite at final milestone. Then typecheck/build, isolated packaged lifecycle/settings smoke, and read-only original-ledger verification via an independent copy. Do not claim ETA accuracy from these functional tests. Preserve any experiment traces privately and exclude them from public project-positioning material.

Written-spec review is required before implementation planning and code changes. The recommended numerical defaults above are starting policy values, not calibrated accuracy or cost claims.
