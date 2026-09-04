# MCP Lease Tracking Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed plugin start its packaged desktop companion correctly and let any loaded Codex conversation report progress without a Hook-provided task handle, while preserving explicit handles, lease isolation, and truthful task-state transitions.

**Architecture:** Generate one opaque fallback task handle in each MCP server process and inject it into the tool handlers. Resolve every task-scoped call to either its validated explicit handle or that process-local fallback, then rely on the existing authenticated MCP lease to isolate ownership. At the HTTP boundary, classify events that may create a task separately from events that require an existing task. At the process boundary, clone the MCP environment and remove only `ELECTRON_RUN_AS_NODE` before spawning the Electron `--hud` child.

**Tech Stack:** TypeScript 7, Node.js 22, Electron 44, MCP TypeScript SDK, Zod 4, Vitest 4, PowerShell/NSIS packaging, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-04-mcp-lease-tracking-fallback-design.md`

## Global Constraints

- Keep the fallback handle process-local and content-free. Never derive it from prompts, transcript paths, repository paths, account data, window titles, or machine identifiers.
- Preserve valid explicit `task_handle` behavior and optional Hook compatibility. A malformed explicit handle must fail validation and must never fall back silently.
- Never use the globally selected or most recently active HUD task as an implicit target.
- Only `tracking_start` and `progress_report` may create the fallback task. Pause, resume, stop, validation, and outcome must return `TASK_NOT_FOUND` if the resolved task does not exist.
- Status tools remain observational: they must not create a task, start the companion, or allocate persisted state.
- Include only `associationSource: "explicit" | "mcp_lease"` in bounded task-write results. Never expose the fallback handle, bearer token, lease owner nonce, or lease credentials.
- Clear `ELECTRON_RUN_AS_NODE` only in the spawned desktop child environment. The MCP stdio process must retain Node mode.
- Keep every change in this plan inside the repository and limited to the approved product behavior.
- Do not begin ETA v2 in this plan. Its multi-expert estimator and evaluation harness start only after this baseline is installed and accepted.
- Before every production-code task, run the stated RED test and confirm that it fails for the expected reason. After implementation, run the focused test and commit only that task's coherent change.

---

## Task 1: Sanitize the Electron desktop child environment

**Files:**

- Modify: `src/lifecycle/process-launcher.ts`
- Modify: `tests/lifecycle/companion-manager.test.ts`

- [ ] Add a failing launcher test that injects a parent environment containing both `ELECTRON_RUN_AS_NODE: "1"` and a sentinel, then asserts the child receives the sentinel but not Electron Node mode.

```ts
it("removes Electron Node mode only from the desktop child environment", async () => {
  const child = { pid: 9123, unref: vi.fn(), kill: vi.fn(() => true) };
  const spawnProcess = vi.fn(() => child);
  const parentEnvironment = {
    ELECTRON_RUN_AS_NODE: "1",
    CODEX_PROGRESS_HUD_DATA_DIR: "C:\\isolated-data",
    HUD_SENTINEL: "preserved"
  };
  const launcher = createProcessLauncher(spawnProcess, parentEnvironment);

  await launcher.spawnHud("C:\\Program Files\\HUD\\hud.exe", { generation: 7 });

  expect(spawnProcess).toHaveBeenCalledWith(
    "C:\\Program Files\\HUD\\hud.exe",
    ["--hud", "--manager-generation=7"],
    expect.objectContaining({
      env: {
        CODEX_PROGRESS_HUD_DATA_DIR: "C:\\isolated-data",
        HUD_SENTINEL: "preserved"
      }
    })
  );
  expect(parentEnvironment.ELECTRON_RUN_AS_NODE).toBe("1");
});
```

- [ ] Run `npm test -- --run tests/lifecycle/companion-manager.test.ts -t "removes Electron Node mode"` and confirm RED because `createProcessLauncher` does not accept or pass an environment.
- [ ] Change the factory signature and clone/sanitize the environment at spawn time.

```ts
export function createProcessLauncher(
  spawnProcess: SpawnProcess = spawn,
  environment: NodeJS.ProcessEnv = process.env
): ProcessLauncher {
  return {
    async spawnHud(executablePath, options) {
      const childEnvironment = { ...environment };
      delete childEnvironment.ELECTRON_RUN_AS_NODE;
      const child = spawnProcess(executablePath, [
        "--hud",
        `--manager-generation=${options.generation}`
      ], {
        detached: true,
        env: childEnvironment,
        stdio: "ignore",
        shell: false
      });
      if (child.pid === undefined) throw new Error("HUD process did not provide a PID");
      child.unref();
      return {
        pid: child.pid,
        async terminate(): Promise<void> {
          child.kill();
        }
      };
    }
  };
}
```

- [ ] Update the existing exact spawn-options assertion to include the sanitized `env`; inject a small deterministic environment there instead of asserting the machine's full `process.env`.
- [ ] Run `npm test -- --run tests/lifecycle/companion-manager.test.ts` and confirm all lifecycle-manager and launcher tests pass.
- [ ] Run `npm run typecheck` and confirm no `SpawnOptions` or environment typing errors.
- [ ] Commit with `git add src/lifecycle/process-launcher.ts tests/lifecycle/companion-manager.test.ts && git commit -m "fix: sanitize desktop child environment"`.

---

## Task 2: Add a process-local task association primitive

**Files:**

- Create: `src/mcp/task-association.ts`
- Create: `tests/mcp/task-association.test.ts`

- [ ] Write focused RED tests for deterministic generation, schema compatibility, explicit precedence, and fallback resolution.

```ts
describe("MCP task association", () => {
  const fallbackTaskHandle = "hud_ZmFsbGJhY2staGFuZGxlLTEyMzQ";

  it("generates a schema-compatible content-free handle", () => {
    const handle = createFallbackTaskHandle(() => Buffer.alloc(24, 7));
    expect(handle).toMatch(/^hud_[A-Za-z0-9_-]{20,96}$/u);
  });

  it("prefers a validated explicit handle", () => {
    expect(resolveTaskAssociation("hud_aaaaaaaaaaaaaaaaaaaa", fallbackTaskHandle))
      .toEqual({ taskHandle: "hud_aaaaaaaaaaaaaaaaaaaa", source: "explicit" });
  });

  it("uses the MCP-process fallback only when the handle is absent", () => {
    expect(resolveTaskAssociation(undefined, fallbackTaskHandle))
      .toEqual({ taskHandle: fallbackTaskHandle, source: "mcp_lease" });
  });
});
```

- [ ] Run `npm test -- --run tests/mcp/task-association.test.ts` and confirm RED because the module does not exist.
- [ ] Implement the narrow API without reading global task state.

```ts
import { randomBytes } from "node:crypto";

export type TaskAssociationSource = "explicit" | "mcp_lease";

export interface ResolvedTaskAssociation {
  taskHandle: string;
  source: TaskAssociationSource;
}

export function createFallbackTaskHandle(
  byteSource: (size: number) => Buffer = randomBytes
): string {
  return `hud_${byteSource(24).toString("base64url")}`;
}

export function resolveTaskAssociation(
  explicitTaskHandle: string | undefined,
  fallbackTaskHandle: string
): ResolvedTaskAssociation {
  return explicitTaskHandle === undefined
    ? { taskHandle: fallbackTaskHandle, source: "mcp_lease" }
    : { taskHandle: explicitTaskHandle, source: "explicit" };
}
```

- [ ] Add a test proving two calls to the real generator produce different handles, while keeping the deterministic byte-source test non-flaky.
- [ ] Run `npm test -- --run tests/mcp/task-association.test.ts` and `npm run typecheck`; confirm both pass.
- [ ] Commit with `git add src/mcp/task-association.ts tests/mcp/task-association.test.ts && git commit -m "feat: add MCP task association primitive"`.

---

## Task 3: Make non-creating semantic events require an existing task

**Files:**

- Modify: `src/server/http-server.ts`
- Modify: `tests/server/http-server.test.ts`
- Modify: `tests/server/lease-http.test.ts`

- [ ] Extend the HTTP tests so an unknown task receives `404` plus `{ code: "TASK_NOT_FOUND" }` for each of these events: `tracking_paused`, `tracking_resumed`, `tracking_stopped`, `validation_observed`, and `model_outcome`.
- [ ] Add a companion lease test proving rejection happens before lease binding and does not create or preclaim the unknown task handle.

```ts
it.each([
  { type: "tracking_paused" },
  { type: "tracking_resumed" },
  { type: "tracking_stopped" },
  { type: "validation_observed", result: "passed" },
  { type: "model_outcome", outcome: "completed", verified: false }
])("rejects unknown non-creating event $type", async (event) => {
  const response = await postEvent({ taskId: unknownTaskHandle, event });
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toMatchObject({ code: "TASK_NOT_FOUND" });
  expect(store.snapshot().tasks).toHaveLength(0);
});
```

- [ ] Run `npm test -- --run tests/server/http-server.test.ts tests/server/lease-http.test.ts` and confirm RED specifically for validation and outcome, which currently reach `store.apply`.
- [ ] Replace the control-only predicate with an explicit creation policy.

```ts
function eventRequiresExistingTask(event: ProgressEnvelope["event"]): boolean {
  return event.type !== "tracking_started" && event.type !== "model_progress" &&
    event.type !== "waiting";
}
```

- [ ] Use that predicate before `runMutation`; retain protocol checks for controls and the existing `TASK_NOT_FOUND` response body. Do not broaden creation permission for Hook endpoints.
- [ ] Add positive tests proving `tracking_started`, `model_progress`, and `waiting` still create a new task through `/api/events`.
- [ ] Run the two focused server suites and then `npm test -- --run tests/core/reducer.test.ts tests/server/http-server.test.ts tests/server/lease-http.test.ts`; confirm all pass.
- [ ] Commit with `git add src/server/http-server.ts tests/server/http-server.test.ts tests/server/lease-http.test.ts && git commit -m "fix: reject terminal events for unknown tasks"`.

---

## Task 4: Resolve handle-free MCP calls and expose bounded association metadata

**Files:**

- Modify: `src/mcp/tools.ts`
- Modify: `tests/mcp/tools.test.ts`

- [ ] Change the test helper to inject a stable fallback handle into every handler instance.

```ts
const fallbackTaskHandle = "hud_ZmFsbGJhY2staGFuZGxlLTEyMzQ";

function createHandlers(progressClient, companionManager = createManager()) {
  return createToolHandlers({
    progressClient,
    companionManager,
    fallbackTaskHandle
  });
}
```

- [ ] Replace the obsolete `NO_SESSION_ASSOCIATION` tests with a table covering all handle-free write tools. Assert `tracking_start` and `progress_report` submit to `fallbackTaskHandle`; assert pause/resume/stop/validation/outcome target that same handle and preserve a downstream `TASK_NOT_FOUND` rather than selecting another task.
- [ ] Add tests proving: valid explicit handles win; malformed explicit handles never submit; status tools do not submit or call `ensureForWrite`; structured write success and failure include `associationSource`; structured data never includes the fallback handle, owner nonce, or token.

```ts
expect(result.structuredContent).toMatchObject({
  ok: true,
  associationSource: "mcp_lease"
});
expect(result.structuredContent).not.toHaveProperty("taskHandle");
```

- [ ] Run `npm test -- --run tests/mcp/tools.test.ts` and confirm RED because schemas and handlers still reject missing handles and omit association metadata.
- [ ] Make `task_handle` optional in `progressReportSchema`, `taskOutcomeSchema`, and `validationObservedSchema`; retain `taskHandleSchema` unchanged so malformed supplied values still fail Zod validation.
- [ ] Extend the dependency and payload types.

```ts
export interface ToolHandlerDependencies {
  progressClient: ProgressClient;
  companionManager: CompanionManager;
  fallbackTaskHandle: string;
}

export interface HudToolPayload {
  ok: boolean;
  associationSource?: TaskAssociationSource;
  // Preserve existing lifecycle/error fields.
}
```

- [ ] Parse first, then call `resolveTaskAssociation(parsed.data.task_handle, fallbackTaskHandle)` for every task-scoped write. Remove `noSessionAssociationResult` and `controlHandle`; never call `client.status()` to choose an implicit task.
- [ ] Refactor task write result helpers so successful writes, `TASK_NOT_FOUND`, lease failures, startup failures, and manual suppression include only the resolved `associationSource`. Invalid Zod input has no association metadata because no effective association was established.
- [ ] Keep retry and shared-deadline behavior unchanged: association resolution occurs once before `CompanionManager.executeWrite`, and both attempts use the same task handle and source.
- [ ] Run `npm test -- --run tests/mcp/tools.test.ts tests/lifecycle/companion-manager.test.ts` and `npm run typecheck`; confirm all pass.
- [ ] Commit with `git add src/mcp/tools.ts tests/mcp/tools.test.ts && git commit -m "feat: support handle-free MCP task writes"`.

---

## Task 5: Wire one fallback per MCP process and prove lease isolation

**Files:**

- Modify: `src/mcp/main.ts`
- Modify: `tests/mcp/stdio-server.test.ts`
- Modify: `tests/integration/companion-lifecycle.test.ts`

- [ ] Update the stdio test expectations so task-write schemas require `phase` or their semantic fields but do not require `task_handle`.
- [ ] Extend the stdio scenario to call, in order, handle-free `tracking_start`, `progress_report`, `validation_observed`, and `task_outcome`; assert each result reports `associationSource: "mcp_lease"` and the final lease-filtered snapshot contains exactly one task.
- [ ] Add an integration test that creates two independent MCP clients against one companion. Start a handle-free task from each process, assert two distinct tasks coexist, and assert a valid explicit attempt by client B to pause client A's handle returns `LEASE_FORBIDDEN`.
- [ ] Run `npm test -- --run tests/mcp/stdio-server.test.ts tests/integration/companion-lifecycle.test.ts` and confirm RED because `runMcpServer` has not generated or injected a fallback.
- [ ] Generate the fallback exactly once during `runMcpServer` startup, independently of `ownerNonce`.

```ts
const ownerNonce = randomUUID();
const fallbackTaskHandle = createFallbackTaskHandle();
const handlers = createToolHandlers({
  progressClient,
  companionManager,
  fallbackTaskHandle
});
```

- [ ] Update task-tool descriptions to state that a supplied opaque handle is used when available and otherwise the process's MCP-lease association is used. Remove claims that every call requires a Hook-injected handle or that Hook tracking is unconditional.
- [ ] Confirm the fallback is neither logged nor returned in tool `structuredContent`.
- [ ] Run the focused MCP/lease/integration suites, then `npm run diagnose:mcp`; confirm all pass and public child stdout remains JSON-RPC only.
- [ ] Commit with `git add src/mcp/main.ts tests/mcp/stdio-server.test.ts tests/integration/companion-lifecycle.test.ts && git commit -m "feat: bind MCP processes to fallback tasks"`.

---

## Task 6: Align the public product contract and generated plugin mirror

**Files:**

- Modify: `skills/progress-reporting/SKILL.md`
- Modify: `README.md`
- Modify: `PRIVACY.md`
- Modify: `docs/INSTALL-WINDOWS.md`
- Modify: `docs/KNOWN-SIDE-EFFECTS.md`
- Modify: `docs/THREAT_MODEL.md`
- Modify: `docs/RELEASE-CHECKLIST.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `tests/packaging/release-contract.test.ts`
- Modify generated mirror via `npm run sync:plugin`: `plugins/codex-progress-hud/**`

- [ ] Add release-contract assertions that the reporting skill says: use a supplied valid handle when available; otherwise omit it and use MCP-lease fallback; never invent a handle. Assert the public docs disclose that plugin enablement makes tools available but does not force model calls, and that one MCP process may be shared by multiple conversations.
- [ ] Add negative assertions against unconditional phrases such as “automatic Hook tracking does not require this tool” and “always pass the Hook-injected task_handle.” Keep the validator's `manifest.hooks === undefined` rule unchanged.
- [ ] Run `npm test -- --run tests/packaging/release-contract.test.ts` and confirm RED on the old Hook-only language.
- [ ] Rewrite the skill's operational contract:

```md
For a task-scoped call, pass a valid opaque `task_handle` only when Codex supplied one.
Otherwise omit `task_handle`; the loaded MCP process uses its lease-scoped fallback.
Never invent, infer, persist, or disclose a task handle.
```

- [ ] Document three distinct concepts consistently: plugin enabled = capabilities loaded; companion running = local HUD service available; task tracking = the executing model/skill emits reports. State that enabling the plugin alone does not guarantee reports.
- [ ] Document restart behavior and multiplexing limitation: an MCP restart creates a new local task, and multiple conversations sharing one MCP process cannot yet be distinguished by the fallback.
- [ ] Preserve privacy guarantees: random handle, process memory only, no transcript or content identifiers, local authenticated lease, no telemetry.
- [ ] Keep Hooks documented as optional best-effort compatibility only; do not add a rejected top-level manifest `hooks` field.
- [ ] Update plugin descriptions without promising autonomous background observation or control of Codex execution.
- [ ] Run `npm run sync:plugin`, then `npm run check:plugin-sync`, `npm run validate:plugin`, and the focused release-contract test.
- [ ] Inspect `git diff --check` and `git diff -- plugins/codex-progress-hud/skills/progress-reporting/SKILL.md skills/progress-reporting/SKILL.md`; confirm the generated skill mirror is byte-for-byte aligned and no private-goal language appears.
- [ ] Commit with `git add skills README.md PRIVACY.md docs .codex-plugin plugins tests/packaging/release-contract.test.ts && git commit -m "docs: document MCP lease fallback tracking"`.

---

## Task 7: Package the lifecycle fix as version 0.2.1 and strengthen packaged smoke

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `tests/packaging/release-contract.test.ts`
- Modify: `scripts/smoke-packaged.mjs`
- Modify: `scripts/diagnose-packaged-mcp.mjs`
- Modify generated release files via `npm run generate:capabilities` and `npm run sync:plugin`

- [ ] First change the packaged smoke test flow so it starts only the MCP transport with `ELECTRON_RUN_AS_NODE=1`, calls `hud_open`, polls authenticated `/api/health`, asserts `observedState: "running"`, then calls handle-free `tracking_start` and `progress_report`. Remove the direct pre-started HUD process, because it masks the inherited-environment defect.
- [ ] Change the packaged MCP diagnostic to read the release version from `package.json` instead of embedding `0.2.0`, call `hud_open`, and verify a handle-free task write succeeds before closing the HUD.
- [ ] Run these tests against the current 0.2.0 package before implementing the launcher fix in the artifact and confirm the packaged smoke reproduces `START_TIMEOUT` or missing health.
- [ ] Set the patch version with `npm version 0.2.1 --no-git-tag-version`; update the canonical plugin manifest version to `0.2.1`; regenerate capabilities and the release plugin mirror. Do not create a Git tag or publish yet.
- [ ] Update the release-contract version assertion to `0.2.1`; keep workflow artifact names version-derived rather than hard-coded.
- [ ] Run the complete source gate:

```powershell
npm run verify:release
```

Expected: tests, typecheck, build, service smoke, native launcher build, plugin sync check, plugin validation, and package-contract validation all exit 0.

- [ ] Build fresh distributable artifacts with `npm run release:artifacts` and confirm a 0.2.1 installer, plugin ZIP, and `SHA256SUMS.txt` are produced from reviewed source.
- [ ] Run `npm run smoke:packaged` and `npm run diagnose:mcp:packaged`; confirm the packaged MCP process launches the desktop HUD, sees authenticated health, exposes all 14 tools, and accepts handle-free reporting.
- [ ] Run `git diff --check`, `git status --short`, and `npm test -- --run --maxWorkers=1 --no-file-parallelism` once more after artifact generation.
- [ ] Commit source and reproducible release metadata, excluding ignored binary output, with `git add package.json package-lock.json .codex-plugin src/generated plugins scripts tests config && git commit -m "release: prepare 0.2.1 fallback tracking"`.

---

## Task 8: Review, install, restart, and perform real acceptance

**Files:**

- Review: all changes since `9fd65de`
- Install artifact: `release/Codex-Progress-HUD-Setup-0.2.1.exe`
- Install plugin ZIP produced by `npm run release:artifacts`

- [ ] Invoke `superpowers:requesting-code-review` for one bounded final review of correctness, lease isolation, lifecycle environment handling, public claims, and release readiness. Follow the global agent policy: use `gpt-5.6-sol` with `medium` reasoning effort for this material architectural/release review.
- [ ] If the review finds actionable issues, invoke `superpowers:receiving-code-review`, reproduce each issue, apply one focused fix pass with RED/GREEN tests, and request at most one fix review.
- [ ] Invoke `superpowers:verification-before-completion` and rerun `npm run verify:release`, `npm run smoke:packaged`, `npm run diagnose:mcp:packaged`, `git diff --check`, and `git status --short`. Record exact command outcomes in the final handoff.
- [ ] Read `plugin-creator/SKILL.md` and its update/install reference immediately before installation. Use its cachebuster and reinstall workflow rather than manually editing Codex's plugin cache.
- [ ] Install the 0.2.1 companion silently from the fresh installer, validate `install.json`, then install the matching plugin ZIP with a new cachebuster. Preserve a recoverable backup of the previous installed plugin until acceptance passes.
- [ ] Ask the user to fully quit and reopen Codex at this single unavoidable checkpoint; do not claim the newly installed MCP runtime is loaded before restart.
- [ ] In this existing conversation after restart, call handle-free `tracking_start`, `progress_report`, `validation_observed`, and `task_outcome`; confirm the HUD shows one task with live phase/progress, ETA, and the verified terminal state. Confirm `tracking_status` and `hud_status` remain observational.
- [ ] Start a second isolated MCP diagnostic process and confirm it creates a distinct task and cannot mutate the first process's task. Record `LEASE_FORBIDDEN` for the cross-lease attempt without exposing either handle publicly.
- [ ] Verify manual close suppresses reporting without stopping Codex execution, re-open restores service, and uninstall/disable behavior matches the documented single plugin-level lifecycle contract.
- [ ] Do not push or tag until the user reviews the acceptance result. After approval, invoke `superpowers:finishing-a-development-branch` to choose local merge/push/tag/release actions explicitly.

---

## Plan Completion Checks

- [ ] Spec coverage: every Goal, Tool behavior, Failure handling, Public API/type change, Testing strategy, and Release/migration requirement in the approved spec maps to at least one task above.
- [ ] Placeholder scan: `rg -n "T[O]DO|T[B]D|F[I]XME|some[ ]test|approp[r]iate" docs/superpowers/plans/2026-09-05-mcp-lease-tracking-fallback.md` returns no unresolved implementation placeholder.
- [ ] Type consistency: `associationSource` is spelled identically in types, handlers, tests, stdio results, and docs; its only values are `explicit` and `mcp_lease`.
- [ ] Security consistency: no step logs or returns fallback handles, lease IDs, owner nonces, bearer tokens, prompt text, source code, or transcript paths.
- [ ] Scope consistency: no ETA v2 algorithm or unrelated product work is included in this baseline correction.
