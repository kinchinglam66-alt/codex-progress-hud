# Observer Provider Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit HUD subscription-account replacement and a single Responses-compatible API configuration without changing the main Codex account or duplicating ETA algorithms.

**Architecture:** Keep one scheduler and normalized observation contract. Provider-specific owners handle authentication, transport and accounting; a generation-bound selection owner drains the old provider before activating another. Existing subscription bookkeeping remains intact.

**Tech Stack:** Windows, existing Electron/TypeScript/Zod/Vitest stack, Node SQLite, injected HTTP transport, Electron OS-protected storage.

**Spec:** `docs/superpowers/specs/2026-09-10-observer-provider-selection-design.md` (user approved 2026-09-10).

## Global Constraints

- 一个 HUD 独立 ChatGPT 登录槽位，以及一个可编辑的 API 配置。
- 任一时刻只有一个来源生效。
- 第一次实现仅支持 Responses 协议，不支持 Chat Completions。
- 主 Codex 登录与 HUD 登录独立；不复制主程序凭据。
- 保存设置只保存，不发模型请求。
- 不自动轮换、跨来源回退或清空历史账本。
- 两条通道复用相同输入、提示词、输出校验和估时算法。
- 订阅保留 Luna medium；API 模型由用户明确填写。
- 凭据不进日志、诊断、账本、命令行、源码或 Git。
- 真实合成试探不作为 ETA 准确度证据。本轮不做批量测试。
- Security/auth/accounting review: one `gpt-5.6-sol` / `medium` review, at most one fix review. Implementation workers: `gpt-5.6-luna` / `high` for cross-module work, `medium` for focused UI/tests. Set both fields explicitly.

## Workspace and execution gate

Working source: `C:/Users/asus/Documents/Codex/2026-09-01/z/.hud-reinstall-1a3aa3f-isolated` (not a Git worktree). The main repository at `outputs/codex-progress-hud` has existing changes. Before implementation use the worktree skill to inspect both, identify a bounded source baseline and preserve all current modifications. Do not initialize Git in the preserved source or copy it over the dirty main repository. If integration cannot be established without choosing between conflicting changes, finish independent inspection and request that choice.

All relative file paths below resolve against the chosen verified implementation root. At each task milestone record changed files and test results; commit only in an established Git worktree using an explicit file list, never `git add .`. Installation and live calls are separate final gates, not prerequisites for unit tests.

## File boundaries

- `src/estimation/observer-provider.ts`: provider-neutral result and identity contracts.
- `src/desktop/observer-provider-config.ts`: strict versioned public configuration and atomic persistence.
- `src/desktop/observer-secret-store.ts`: OS-protected API credential persistence only.
- `src/desktop/observer-provider-selection.ts`: selection generation, drain, activation and cancellation.
- `src/desktop/observer-account-settings.ts`: subscription login/inspection actions, not general settings rendering.
- `src/estimation/observer-api-accounting.ts`: durable API reservations and settlements, separate from old subscription rows.
- `src/estimation/observer-api-provider.ts`: Responses request/response adapter, no UI or credentials discovery.
- `src/desktop/observer-api-transport.ts`: HTTPS/proxy transport and cancellation; no business accounting.
- Existing runtime/pilot/settings/preload/renderer/lifecycle: composition only; preserve current recovery functions.
- Existing `openai-provider.ts`: keep disconnected experimental adapter; do not silently activate its fixed prices or old prompt.

## Task 1: Provider-neutral observation contract

**Files:** Create `src/estimation/observer-provider.ts`, `tests/estimation/observer-provider.test.ts`; modify `subscription-session.ts`, `observer-scheduler.ts`, `observer-worker.ts`, and `src/evaluation/pilot-journal.ts` only where their exported types require it.

**Interfaces:** Consume existing `ObserverInput`, `ObserverResponse`, `ObserverSubscriptionResult`. Produce `ObserverResult`, `ObserverUsage`, and `ProviderBinding`; preserve the current subscription export as a compatibility alias where possible.

```ts
export type ProviderBinding = {
  kind: 'subscription' | 'api'; profileId: string; generation: number;
};
export type ObserverUsage = {
  kind: 'subscription-tokens' | 'api-tokens';
  inputTokens: number; outputTokens: number; cachedInputTokens: number;
};
// Move existing result fields unchanged to ObserverResult, replacing ONLY
// its subscription-specific usage member with ObserverUsage | null.
// Keep existing timing, outcomes, provenance and status members unchanged.
```

- [ ] Add a failing contract test for an API usage record and a subscription regression using existing result fixtures:

```ts
it('accepts both billing kinds without inventing usage', () => {
  for (const kind of ['subscription-tokens', 'api-tokens'] as const) {
    const usage: ObserverUsage = {kind, inputTokens: 4, outputTokens: 2, cachedInputTokens: 0};
    expect(usage.kind).toBe(kind);
  }
});
```

- [ ] Run `npm test -- --run tests/estimation/observer-provider.test.ts` and `npm run typecheck`; confirm the new contract fails before implementation.
- [ ] Move the current result interface into the new module without changing runtime behavior; update dependent imports and journal serialization to accept both kinds.
- [ ] Run contract, scheduler and subscription-session suites plus typecheck. Assert missing usage stays null, task completion still requires the same output validation, and unknown refresh still preserves same-goal forecasts.
- [ ] Record/commit only this contract migration after reviewing the diff.

## Task 2: Configuration and protected API key storage

**Files:** Create `src/desktop/observer-provider-config.ts`, `src/desktop/observer-secret-store.ts` and corresponding `tests/desktop/*.test.ts`; reuse `consent-protection.ts` without weakening its encryption checks.

**Interfaces:**

```ts
type ApiConfig = {
  profileId: string; name: string; baseUrl: string; protocol: 'responses';
  model: string; reasoningEffort?: 'low'|'medium'|'high';
  keyRef: string; maxOutputTokens: number; dailyCallLimit: number;
};
type ProviderConfig = {version: 1; selected: 'subscription'|'api'; api: ApiConfig|null};
// Export parseProviderConfig(value: unknown): ProviderConfig.
// Export createObserverSecretStore(path, protection) with:
// put(key: string): Promise<string>, read(ref: string): Promise<string|null>,
// remove(ref: string): Promise<void>. Returned ref is opaque, not a key hash.
```

- [ ] Write failing parsing tests with a complete configuration fixture; reject unknown fields, missing model, HTTP, URL credentials/query/fragment, nonpositive limits. Reject newline/control characters and oversized values. Test encrypted disk bytes do not contain a sentinel key and wrong-user/unavailable protection never produces plaintext fallback.

```ts
it('rejects credentials embedded in endpoint', () => {
  expect(() => parseProviderConfig({version:1,selected:'api',api:{
    profileId:'api-1',name:'test',baseUrl:'https://user:pass@example.test/v1',
    protocol:'responses',model:'test-model',keyRef:'ref-1',
    maxOutputTokens:2048,dailyCallLimit:24
  }})).toThrow();
});
```

- [ ] Run `npm test -- --run tests/desktop/observer-provider-config.test.ts tests/desktop/observer-secret-store.test.ts`; confirm missing implementation failures.
- [ ] Implement strict Zod validation and bounded nonreparse-file reads. Use temporary-file write then atomic replacement; preserve existing file on write failure. Store keys only through injected OS protection; the renderer-facing DTO has `keyConfigured:boolean`, never the key or keyRef.
- [ ] Run both suites and typecheck. Test crash-safe replacement failure, malformed ciphertext, absent config legacy fallback, and disabled encryption.
- [ ] Record/commit this persistence unit. New API profiles default to 24 calls/day and 2,048 output tokens as editable starting settings; no auto-activation.

## Task 3: Generation-bound selection and subscription replacement

**Files:** Create `src/desktop/observer-provider-selection.ts`, `src/desktop/observer-account-settings.ts` and matching tests; modify `observer-runtime.ts`, `observer-pilot.ts`, `observer-consent-store.ts`, `observer-consent.ts`; reuse `observer-login-owner.ts` and verified independent-home preparation.

**Interfaces:**

```ts
interface ProviderOwner {
  close(): Promise<void>;
  inspect(signal: AbortSignal): Promise<{label:string; fingerprint:string}>;
}
// createProviderSelection({open, persist}) owns one ProviderOwner.
// select(config: ProviderConfig, signal: AbortSignal): Promise<void>
// status(): {generation:number; state:'inactive'|'switching'|'ready'|'failed'}
// accepts(generation:number): boolean; close(): Promise<void>
// open(config, signal): Promise<ProviderOwner>; persist(config): Promise<void>
```

- [ ] Write deferred-promise tests demonstrating drain-before-open, generation invalidation and serialized switches:

```ts
expect(selection.accepts(oldGeneration)).toBe(false); // immediately after switch begins
expect(openNew).not.toHaveBeenCalled(); // while old close is unresolved
oldClosed.resolve();
await switching;
expect(openNew).toHaveBeenCalledTimes(1);
```

- [ ] Run `npm test -- --run tests/desktop/observer-provider-selection.test.ts tests/desktop/observer-account-settings.test.ts` and confirm red.
- [ ] Implement switch state with a monotonically increasing generation; reject concurrent mutation while busy. On drain failure stay non-dispatching. Persist selection only after old owner closes; login failure/cancellation remains inactive, never resumes the old account implicitly.
- [ ] Implement subscription replacement using the independent home only: drain, official HUD-only sign-out/login action, then identity reader. Do not equate process exit zero with verified account. Preserve proxy environment and sanitize diagnostics; ensure device flow has a usable authorization URL/code presentation without writing either into diagnostic logs. No live login in tests.
- [ ] Version consent storage: read existing v1 subscription grants for unchanged identity; issue new API grants bound to profile, recipient, key revision, billing mode and data categories. Endpoint/key/account changes invalidate the old binding. Keep old subscription ledger intact; old failures remain visible in history but cannot be relabeled as a new identity's remote quota.
- [ ] Run selection/account/settings/consent/runtime tests and typecheck. Test late results cannot update HUD but still settle the original reservation, restart mid-switch stays inactive, and main Codex home is never touched.
- [ ] Record/commit lifecycle work as a single bounded milestone.

## Task 4: API durable accounting and finite retry policy

**Files:** Create `src/estimation/observer-api-accounting.ts`, `tests/estimation/observer-api-accounting.test.ts`; extend existing neutral usage reporting and provider-scoped recovery status as needed, not old subscription row meanings.

**Interfaces:**

```ts
type ApiReservation = {id:string; profileId:string; generation:number};
// createApiAccounting(path, now) provides reserve(binding, limits),
// markDispatch(id), settle(id, usage|null), cancelBeforeDispatch(id), close().
// reserve returns ApiReservation|null; all transitions are durable promises.
// Optional prices are integer microusd per million tokens plus source/date.
```

- [ ] Write failing SQLite fixture tests for concurrent reservations at the daily cap, settlement twice, restart after dispatch, cancellation before dispatch, and missing usage:

```ts
const results = await Promise.all([reserveOne(), reserveOne()]);
expect(results.filter(Boolean)).toHaveLength(1); // remaining daily capacity is one
await accounting.settle(results.find(Boolean)!.id, null);
expect((await readFixtureRows()).at(-1)?.usageState).toBe('unknown');
```

- [ ] Run `npm test -- --run tests/estimation/observer-api-accounting.test.ts` and confirm red.
- [ ] Implement transactional reserve/dispatch/settle records with immutable original binding and unique request IDs. Use UTC day buckets explicitly. Unknown dispatch remains counted; only proven pre-dispatch cancellation releases a reservation. Never delete history when editing API settings.
- [ ] Implement optional versioned price inputs and conservative reservation before dispatch when amount caps are used. If rates cannot cover every billed token category, disable dollar-cap claims and show cost unknown. No inherited hardcoded experimental prices. Output tokens include provider-reported billable reasoning rather than double-counting it.
- [ ] Run SQLite restart/race tests. Verify 401/403 require user configuration action; 429/5xx/network errors schedule at most one automatic retry per observation, after Retry-After or existing bounded backoff, still charged against admission. Local ledger corruption remains blocking and distinguishable from remote quota.
- [ ] Record/commit accounting milestone; retain this diff for final Sol review.

## Task 5: Responses adapter and proxy transport

**Files:** Create `src/estimation/observer-api-provider.ts`, `src/desktop/observer-api-transport.ts` and matching tests. Consume Task 1 result types, Task 2 API config, Task 4 reservations and existing `observer-contract.ts`/assets.

**Interfaces:**

```ts
type ApiTransport = (url:string, init:RequestInit) => Promise<Response>;
// createObserverApiProvider({config, readKey, transport, accounting, instructions, schema})
// returns the current ObserverWorker-compatible observe/status/disable/close API.
// readKey(): Promise<string|null>; no key discovery or process.env mutation.
```

- [ ] Add a failing mock transport test checking exact model, shared prompt/schema, no tools, Bearer header, `store:false`, output limit and `redirect:'error'`. Return a Responses fixture containing a valid existing observer interpretation; assert its task state/estimate matches subscription fixture behavior.

```ts
expect(sentBody.model).toBe(config.model);
expect(sentBody.tools).toBeUndefined();
expect(sentBody.store).toBe(false);
expect(sentInit.redirect).toBe('error');
expect(result.interpretation).toEqual(expectedObserverResponse);
```

- [ ] Run `npm test -- --run tests/estimation/observer-api-provider.test.ts tests/desktop/observer-api-transport.test.ts`; confirm red.
- [ ] Implement input packing with existing observer packer and schema validation, not old metrics-only prompt. Resolve base URL to `/responses` retaining explicitly configured path prefix. Bound request lifetime to 60 seconds and response bytes to 256 KiB; reject tool calls, multiple conflicting output messages, invalid JSON and incomplete/refused outputs with fixed diagnostics. Settle valid usage even when interpretation fails; usage absent remains unknown, not zero.
- [ ] Implement explicit proxy-capable transport using a verified supported transport library (declare any runtime dependency directly, never rely on transitive installation). Read official library docs before coding transport specifics. Preserve TLS verification and cancellation, reject all redirect responses, release bodies/sockets on failure; no arbitrary auth header entry.
- [ ] Run local fixture-server cases for 401/403/429/5xx, connection reset, TLS error, oversized body, cancellation, malformed usage, and proxy forwarding. Use synthetic secrets only and assert none appear in errors/diagnostic DTOs. No external network or paid calls.
- [ ] Record/commit adapter and transport milestone.

## Task 6: Settings UI and desktop composition

**Files:** Modify `src/desktop/observer-settings.ts`, `observer-pilot.ts`, `lifecycle.ts`, `src/ui/settings-renderer.ts`, `settings.html`, `settings-preload.cjs`; extend existing settings/runtime/renderer tests and create `tests/desktop/observer-provider-integration.test.ts`.

**Interfaces:** Trusted IPC actions `readProviderSettings`, `saveProviderSettings`, `replaceSubscriptionAccount`, `checkProvider`, `trialProvider`, `activateProvider`, `cancelProviderAction`. Mutations carry current generation/revision; secret submission is a write-only payload. No equivalent unauthenticated loopback route.

- [ ] Add failing UI tests for source fields, account identity/time, masked key state, dirty config, busy switch, cancelled login and unsupported protocol. Test saving does not invoke a model:

```ts
await settings.saveProviderSettings(apiDraft);
expect(modelTransport).not.toHaveBeenCalled();
expect(readSettingsResult).not.toHaveProperty('apiKey');
expect(readSettingsResult).not.toHaveProperty('keyRef');
```

- [ ] Run `npm test -- --run tests/desktop/observer-settings.test.ts tests/desktop/observer-provider-integration.test.ts` plus the existing renderer suite; confirm red.
- [ ] Wire settings through trusted sender checks and version binding. Separate local validation, network authentication check, one-shot synthetic trial and activation. Reuse consent for an unchanged binding; show recipient/account and charge warning once for new binding. Clear password input after submission; render fixed messages with textContent.
- [ ] Compose stable scheduler worker slots delegated to the selected provider; select/drain invalidates old generations. Preserve global two-slot and per-conversation single-flight constraints. Keep historical goals/forecasts visible during switch; waiting/paused countdown remains frozen and new goals reset.
- [ ] Run integration tests: old config starts subscription only; API save without activation is inert; restart reuses valid grant; failed API does not invoke subscription; independent main-account change does not silently change HUD; all sources disabled leaves tracking UI usable.
- [ ] Record/commit UI/composition milestone, no production install yet.

## Task 7: Review, documentation, packaged validation and installation

**Files:** Update feature documentation and private progress record; reuse bounded installer and package smoke harness without touching live auth or ledger during tests.

- [ ] Run `npm test -- --run --maxWorkers=1 --no-file-parallelism`, `npm run typecheck`, `npm run build`; record actual counts and outputs. Do not reuse the earlier 1,720 count as new evidence.
- [ ] Run one Sol medium review of auth isolation, secret flow, stale generation settlement, budgeting and installation. Give reviewer minimal diff/spec/test context, read-only access. Fix findings and run focused tests; at most one fix review per user policy.
- [ ] Document supported Responses protocol, local checks versus real tests, account-switch behavior, unknown costs, endpoint privacy and proxy troubleshooting; exclude all private project positioning and credentials from public docs.
- [ ] Build a new versioned candidate. Run isolated packaged startup/settings/shutdown smoke with temporary data and no credentials. Check packaged modules match built source and native EXE/ASAR are a valid pair.
- [ ] Recheck plugin disabled and all relevant processes exited before installation. Use the existing recoverable paired-file installer, preserve login/config/history and verify installed hashes. Never force-close unrelated Codex tasks.
- [ ] After user login/configuration and explicit test approval, run at most one synthetic trial per configured source; record actual returned usage or unknown, not guessed cost. Skip unconfigured API without asking for secrets in chat. Test a real running task only after connectivity succeeds; keep accuracy evaluation separate.
- [ ] Final report distinguishes implemented/tests passed/installed/live verified/remaining user login actions. Commit/push only to a verified integration branch under explicit user authorization.

## Plan self-review

Coverage: selection/scope (Tasks 1–3), credentials/consent (2–3,6), shared algorithm (1,5–6), proxy/API (5), budget/recovery (4), UI (6), backward compatibility and installation (3,7). Source aliases and exported names are defined above; fixtures must use existing valid observer inputs rather than invented production data. No automatic calls or installation are hidden in configuration tests. The source is not currently a Git worktree, so workspace integration is an explicit execution prerequisite rather than an assumed commit.
