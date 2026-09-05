# Independent background estimator design

Status: planning draft requested on 2026-09-05. Production behavior, installation, and cloud calls are unchanged. Event-source availability is a prerequisite to selecting an implementation path.

## Objective

Move recurring ETA interpretation and scheduling out of the task-executing model. Let a local companion asynchronously consult a separately configurable estimation model, with measurable accuracy, bounded spend, and no dependency of task execution on estimation success. Lower total cost is a hypothesis to test, not a promised outcome.

## Architecture choice

| Option | Scheduling owner | Main-task impact | Decision |
| --- | --- | --- | --- |
| Main model repeatedly launches a Codex subagent | Main model and host | Dispatch/context handoff and possibly waiting remain on the task path; runtime API availability is host-specific | Useful for a controlled prototype, not the default product architecture |
| Companion invokes a bounded estimation provider in the background | Local program | No recurring model dispatch is required from the main model if independent observations are available | Recommended target |
| Local statistical estimator only | Local program | No extra inference requests; weak semantic interpretation for unfamiliar tasks | Required baseline and failure fallback |

The recommended provider performs one bounded read-only inference per request. It has no filesystem, shell, browser, task-control, or delegation tools. A reasoning model need not become an autonomous agent to return a useful estimate. The term observer subagent describes its role; a persistent agent session is not required.

Development subagents are separate: implementation/review workers follow the user's existing model and reasoning-effort routing policy. These development settings are not automatically product model choices or API identifiers.

## Current code and constraint

`src/core/eta.ts` combines progress-derived, model-supplied, and calibration signals. Model-reported confidence influences weighting. `src/core/calibration.ts` currently aggregates phase duration/error; it is not empirical prediction-interval calibration. `src/server/task-store.ts` stores local task records. MCP writes and optional Hooks currently feed those records.

Reading that store with a second model adds no independently observed facts. Without a separate feed, an external estimator remains dependent on main-model reports. Likewise, the existing MCP-process fallback does not identify multiple conversations sharing one MCP process.

## Observation prerequisite

Evaluate these routes separately:

1. A documented, authorized event subscription to the already-running Codex Desktop host, carrying conversation and turn identity.
2. A client-owned App Server session. This can establish API feasibility but must not be reported as observing an existing GUI conversation. Moving task execution to a custom client is a product-scope change requiring a separate decision.
3. Optional supported Hooks with task identifiers, where the installed host demonstrably executes them.
4. Existing cooperative MCP reports as an explicitly labeled degraded mode.

Official App Server documentation describes item, plan, turn lifecycle, and usage events. That establishes event vocabulary, not a plugin's right or ability to attach to arbitrary Desktop transports. Do not read undocumented transcript databases, inspect private credentials, scrape screens, or derive identity from repository paths/window titles to bypass this uncertainty.

A source is sufficient for independent mode only if real evidence establishes task identity, fresh activity, reconnect boundaries, and source provenance without requiring recurring main-model HUD calls. Report missing capabilities individually. A turn-completed event is not proof that the user's complete task or deliverable is finished.

## Intended data flow

Supported source -> local identity mapping and allowlist -> local event/state store -> asynchronous scheduler -> estimation provider -> output validation and empirical calibration -> HUD.

Usage counters, elapsed time, known waits, cancellation signals, and UI refresh remain deterministic local operations. The estimator supplies semantic phase/risk and an ETA distribution or interval. It cannot declare authoritative interruption or verified completion.

For an eventual provider request, use a per-estimation opaque key, local task generation, observation sequence, elapsed active time, bounded tool-duration/count categories, and plan-status counts. Provider results cannot choose their own target task. Carry identity and sequence locally around the call; drop results for a replaced task generation, stopped/terminal task, changed source epoch, or superseded observation sequence. In busy streams, coalesce updates and show stale/unknown rather than freezing work to obtain a prediction.

Numeric metadata is the default payload. A bounded task brief and sanitized plan descriptions may improve semantic estimation but require separate content-sharing consent. No prompt transcript, raw reasoning, source code, file paths, command strings, original IDs, credentials, or raw tool output is sent by default. All content supplied to the estimator is data, never executable instructions.

## Initial scheduling and spending policy

These are proposed engineering defaults, subject to measurement:

- Disabled by default. No credential or model choice is inferred from the current Codex session.
- Trigger on meaningful phase/plan changes, failed validations, and resumed activity; do not poll a model merely to animate a countdown.
- At least 30 seconds between requests for the same task; at most 20 requests per task per rolling hour. Coalesce bursts into the latest eligible observation.
- One in-flight request per task; at most two globally, with fair task selection and a bounded queue.
- Fifteen-second total deadline per inference. No automatic retry in the first version; later events may trigger another request after the cooldown. Cancellation releases scheduler slots even if the transport fails to abort promptly.
- Token limits, model identity, maximum billable generation, and per-task/global monetary caps are explicit configuration. Live cloud mode requires an explicit positive budget and a supported price model; unknown price/accounting means no automatic dispatch.
- Reserve a conservative maximum estimated charge before dispatch, including billable reasoning where applicable. Reconcile reported usage afterward; keep reservations for ambiguous timeouts until their accounting window closes. Treat provider spend controls as additional protection, not proof that local cancellation prevented billing.
- Disable cancels queued/in-flight work where supported; stale callbacks cannot update the HUD. Existing lifecycle shutdown owns worker cleanup. Do not add a second global plugin switch.

A lower-price provider can reduce cost per request, but more requests or larger transferred context can exceed the main-model reporting cost. Report both budgets separately and compare total cost only where measurement supports it. Do not assume Codex subscription access includes direct API billing or that app-internal subagent APIs are shipped plugin interfaces.

## Output and confidence

Reject invalid schema, nonfinite/negative times, reversed intervals, unsupported field values, and oversized responses. Preserve an unavailable result when evidence is insufficient. Structured output validation is not factual validation.

Keep model self-reported certainty distinct from empirical interval coverage. Fit calibration on training tasks and evaluate on held-out tasks; do not promote self-confidence directly to a coverage guarantee. Store predictions separately from task truth. Keep remaining active work and human/external waiting estimates distinct.

## Evaluation and adoption decision

Compare local-only, cooperative-main-model, and independent-model modes. Replay identical observation prefixes for predictor comparison, and separately measure end-to-end live workflow overhead because changing reporting changes the execution trajectory. Do not feed future outcomes or completed-task summaries into earlier predictions.

Measure absolute ETA error, p50/p90 error, relative error with near-zero handling, interval coverage and width, status mistake rates, observation staleness, missing-report rate, main-task overhead, total input/output/reasoning tokens, request count, and cost. Interrupted/unfinished tasks are censored or separately evaluated; never label them as successful completion samples. Compare errors on matched horizons/tasks, not only on predictions a model chose to answer.

Begin with synthetic traces to test correctness, then an explicitly consented task-disjoint pilot covering exploration, implementation, testing, retries, and waiting. A provisional pilot target is at least 50 held-out task runs; that is not evidence of broad generalization. Pre-register the effect size, coverage target, and spend ceiling before running a paid comparison. Default adoption requires repeatable benefit against both baselines without worsening false-completion behavior or exceeding the chosen budget.

Shadow mode records bounded estimates locally for evaluation and does not replace the displayed ETA. Persisted evaluation data and sending data to a provider each need explicit controls; existing privacy documentation must change before enabling either.

## Delivery sequence

1. Evidence-backed source feasibility and a go/degraded/no-go decision for the existing GUI product.
2. Local observation contracts and deterministic replay, with no cloud calls.
3. Mock-provider asynchronous scheduler, identity isolation, stale-result guards, and budget tests.
4. Optional provider adapter with explicit credentials, model and budget configuration; no real inference without that setup.
5. Shadow-mode comparative evaluation and calibration.
6. Display integration only after evaluation; release documentation and installed lifecycle acceptance.

Provider/model selection, API billing setup and exact performance acceptance thresholds are decision gates, not preapproved runtime settings. No automatic escalation to a more expensive model.

## Sources

- [Codex App Server events](https://learn.chatgpt.com/docs/app-server): describes stream identities/events; existing Desktop subscription availability remains unverified.
- [OpenAI latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization): reduce requests, use appropriate model sizes, parallelize independent work.
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data): consult current provider retention conditions before implementing cloud mode.
