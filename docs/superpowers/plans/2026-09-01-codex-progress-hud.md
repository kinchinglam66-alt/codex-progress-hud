# Codex Progress HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a testable Windows-first Codex progress overlay and plugin that display task state, progress, and honest ETA ranges from structured reports.

**Architecture:** An Electron process hosts a loopback-only HTTP/SSE service and an always-on-top renderer. A separate stdio MCP server forwards structured model reports to that service; a pure reducer and ETA estimator keep lifecycle and prediction logic independent from both transports.

**Tech Stack:** Node.js 24, TypeScript, Electron, Vitest, MCP TypeScript SDK, Zod, native HTTP/SSE

**Spec:** `docs/superpowers/specs/2026-09-01-codex-progress-hud-design.md`

## Global Constraints

- Bind network listeners to `127.0.0.1` only.
- Require bearer authentication for mutating endpoints.
- Do not persist raw prompts, reasoning, command output, access tokens, or file contents.
- Never infer semantic task completion solely from `turn/completed`.
- Display ETA as a range with confidence, never as a precise countdown.
- Do not depend on undocumented Codex GUI internals.
- Use Apache-2.0 and include a non-affiliation trademark notice.

---

### Task 1: Repository and plugin skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.codex-plugin/plugin.json`
- Create: `.mcp.json`
- Create: `skills/progress-reporting/SKILL.md`

**Interfaces:**
- Produces: npm scripts `test`, `typecheck`, `build`, `start`, and `validate:plugin`.
- Produces: MCP server entry `node dist/mcp/main.js`.

- [ ] **Step 1: Generate the validated plugin scaffold**

Run the bundled `create_basic_plugin.py` with `--with-skills --with-scripts --with-assets --with-mcp`, targeting the repository parent.

- [ ] **Step 2: Add Node and TypeScript configuration**

Set ESM output, strict type checking, source maps, and npm scripts that run Vitest, TypeScript, the asset copier, Electron, and the bundled plugin validator.

- [ ] **Step 3: Install and lock dependencies**

Run `npm install @modelcontextprotocol/sdk zod` and `npm install --save-dev electron typescript vitest @types/node` so `package-lock.json` records exact resolution.

- [ ] **Step 4: Verify the empty test and typecheck baseline**

Run `npm test -- --run` and `npm run typecheck`; both must exit zero before behavior is added.

### Task 2: Lifecycle reducer

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/reducer.ts`
- Test: `tests/core/reducer.test.ts`

**Interfaces:**
- Consumes: typed `ProgressEvent` values.
- Produces: `createInitialTask(id, title)` and `reduceTask(state, event, nowMs): TaskSnapshot`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover turn start, plan updates, waiting approval, explicit failure/interruption precedence, model-reported progress, and verified versus unverified completion.

- [ ] **Step 2: Run the reducer tests and confirm the missing-module failure**

Run `npm test -- --run tests/core/reducer.test.ts` and verify failure is caused by the absent reducer.

- [ ] **Step 3: Implement the minimal typed reducer**

Normalize plan weights, clamp reported progress to `[0, 1]`, retain authoritative terminal states, and record `lastActivityAt` separately from active elapsed time.

- [ ] **Step 4: Run reducer tests to green**

Run `npm test -- --run tests/core/reducer.test.ts` and require zero failures.

### Task 3: ETA estimator

**Files:**
- Create: `src/core/eta.ts`
- Test: `tests/core/eta.test.ts`

**Interfaces:**
- Consumes: `TaskSnapshot` and optional `modelEstimateSeconds`.
- Produces: `estimateRemaining(snapshot, nowMs): EtaEstimate | null`.

- [ ] **Step 1: Write failing ETA behavior tests**

Use hand-calculated fixtures for plan throughput, blended model estimates, confidence widening, exploration risk, and null ETA during waiting or terminal states.

- [ ] **Step 2: Run the ETA tests and verify the expected failure**

Run `npm test -- --run tests/core/eta.test.ts`.

- [ ] **Step 3: Implement the minimal estimator**

Blend plan and model estimates by confidence, apply bounded risk multipliers, and return rounded low/high seconds with `0..1` confidence.

- [ ] **Step 4: Run ETA and reducer tests to green**

Run `npm test -- --run tests/core` and require zero failures.

### Task 4: Authenticated local service and live stream

**Files:**
- Create: `src/server/token-store.ts`
- Create: `src/server/task-store.ts`
- Create: `src/server/http-server.ts`
- Test: `tests/server/http-server.test.ts`

**Interfaces:**
- Produces: `createProgressServer({host, port, tokenPath})` returning `{listen, close, address, store}`.
- Exposes: `GET /api/snapshot`, authenticated `POST /api/events`, and authenticated `GET /api/events` SSE.

- [ ] **Step 1: Write failing HTTP integration tests**

Verify loopback defaults, unauthenticated mutation rejection, valid event reduction, malformed and oversized body rejection, and SSE snapshot delivery using a real ephemeral server.

- [ ] **Step 2: Run the HTTP tests and verify failure**

Run `npm test -- --run tests/server/http-server.test.ts`.

- [ ] **Step 3: Implement token storage, task store, HTTP routes, and SSE**

Use `crypto.randomBytes(32)`, constant-time token comparison, a 64 KiB JSON body limit, and heartbeat comments that do not alter task state.

- [ ] **Step 4: Run server and core tests to green**

Run `npm test -- --run tests/server tests/core` and require zero failures.

### Task 5: MCP reporting tools

**Files:**
- Create: `src/mcp/report-client.ts`
- Create: `src/mcp/tools.ts`
- Create: `src/mcp/main.ts`
- Test: `tests/mcp/tools.test.ts`
- Modify: `.mcp.json`
- Modify: `skills/progress-reporting/SKILL.md`

**Interfaces:**
- Produces: `progress_report`, `task_outcome`, and `task_status` MCP tools.
- Consumes: local service URL and token path from environment variables with safe local defaults.

- [ ] **Step 1: Write failing tool-handler tests**

Assert normalized event payloads, rejection of invalid confidence/progress, and clear offline errors without asserting MCP framework internals.

- [ ] **Step 2: Run MCP handler tests and verify failure**

Run `npm test -- --run tests/mcp/tools.test.ts`.

- [ ] **Step 3: Implement handlers and stdio registration**

Validate every model-provided field with Zod, forward only the documented minimal payload, and keep diagnostic text free of secrets.

- [ ] **Step 4: Write the reporting skill and MCP command configuration**

Require reports on task start, plan changes, phase changes, waiting, validation failure, and final outcome; prohibit invented percentages when no plan exists.

- [ ] **Step 5: Run MCP and core tests to green**

Run `npm test -- --run tests/mcp tests/core` and require zero failures.

### Task 6: Electron overlay

**Files:**
- Create: `src/desktop/main.ts`
- Create: `src/ui/index.html`
- Create: `src/ui/styles.css`
- Create: `src/ui/renderer.ts`
- Create: `src/ui/view-model.ts`
- Create: `scripts/copy-assets.mjs`
- Test: `tests/ui/view-model.test.ts`

**Interfaces:**
- Consumes: `TaskSnapshot` from `/api/snapshot` and `/api/events`.
- Produces: compact task card text, status tone, progress mode, ETA label, and last-update label.

- [ ] **Step 1: Write failing view-model tests**

Cover determinate and indeterminate progress, ETA ranges, waiting labels, suspected interruption, failure, and verified completion without DOM mocks.

- [ ] **Step 2: Run UI tests and verify failure**

Run `npm test -- --run tests/ui/view-model.test.ts`.

- [ ] **Step 3: Implement the pure view model and renderer**

Render text labels as well as color, update from SSE, and reconnect with bounded exponential backoff.

- [ ] **Step 4: Implement the secure overlay window**

Use a frameless transparent `BrowserWindow` with `alwaysOnTop`, `contextIsolation`, sandboxing, no Node integration, and a loopback URL served by the local service.

- [ ] **Step 5: Build and run UI tests**

Run `npm test -- --run tests/ui` followed by `npm run build`.

### Task 7: Open-source release hygiene

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `NOTICE`
- Create: `PRIVACY.md`
- Create: `SECURITY.md`
- Create: `CONTRIBUTING.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `docs/THREAT_MODEL.md`
- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`

**Interfaces:**
- Produces: public installation, development, privacy, vulnerability-reporting, and contribution contracts.

- [ ] **Step 1: Document supported and experimental behavior**

Explain that model reports are cooperative, stock-GUI App Server attachment is not guaranteed, the project stores no raw task content, and the project is not affiliated with OpenAI.

- [ ] **Step 2: Add license, notices, security policy, and threat model**

Use Apache-2.0, identify local bearer-token and prompt-injection risks, and provide a private vulnerability-reporting path through GitHub Security Advisories.

- [ ] **Step 3: Add reproducible CI and dependency updates**

CI installs with `npm ci`, then runs tests, type checking, build, and plugin validation on Windows and Ubuntu.

- [ ] **Step 4: Verify repository hygiene**

Run a secret-pattern scan over tracked files, inspect `git status`, and confirm build output, local tokens, databases, logs, and `.env` files are ignored.

### Task 8: Final verification

**Files:**
- Modify only files required by verification findings.

**Interfaces:**
- Produces: evidence that the repository is ready for owner review before GitHub publication.

- [ ] **Step 1: Run the complete automated suite**

Run `npm test -- --run`, `npm run typecheck`, `npm run build`, and `npm run validate:plugin` from a clean checkout state.

- [ ] **Step 2: Run a local smoke test**

Start the compiled progress service, submit an authenticated synthetic task event, read the resulting snapshot, and shut the process down.

- [ ] **Step 3: Review the acceptance criteria and Git diff**

Map each criterion in the design spec to test or documentation evidence and inspect `git diff --check` plus `git status --short`.

