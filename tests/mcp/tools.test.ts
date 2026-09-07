import { describe, expect, it, vi } from "vitest";
import {
  createCompanionManager,
  type CompanionManager
} from "../../src/lifecycle/companion-manager.js";
import type { HudHealth, LifecycleStateStore } from "../../src/lifecycle/types.js";
import { HudClientError } from "../../src/mcp/report-client.js";
import {
  createToolHandlers,
  progressReportSchema,
  taskHandleSchema
} from "../../src/mcp/tools.js";

function createManager(overrides: Partial<CompanionManager> = {}): CompanionManager {
  const controller = new AbortController();
  const manager = {
    status: vi.fn(async () => ({ observedState: "running" as const })),
    open: vi.fn(async () => ({
      desiredState: "on" as const,
      observedState: "running" as const
    })),
    hide: vi.fn(async () => ({
      desiredState: "on" as const,
      observedState: "hidden" as const
    })),
    close: vi.fn(async () => ({
      desiredState: "off" as const,
      observedState: "stopped" as const
    })),
    ensureForWrite: vi.fn(async () => ({
      kind: "ready" as const,
      generation: 7,
      snapshot: { desiredState: "on" as const, observedState: "running" as const }
    })),
    diagnose: vi.fn(async () => ({ path: "C:\\diagnostics\\hud.md" })),
    ...overrides
  } as CompanionManager;
  manager.executeWrite = overrides.executeWrite ?? vi.fn(async (reason, operation) => {
    let ensured = await manager.ensureForWrite(reason);
    if (ensured.kind !== "ready") return ensured;
    const generation = ensured.generation;
    try {
      return {
        kind: "completed" as const,
        value: await operation(() => ({
          generation,
          signal: controller.signal
        }))
      };
    } catch (error) {
      if (!(error instanceof HudClientError) || error.code !== "OFFLINE") throw error;
      ensured = await manager.ensureForWrite(reason);
      if (ensured.kind !== "ready") return ensured;
      const retryGeneration = ensured.generation;
      return {
        kind: "completed" as const,
        value: await operation(() => ({
          generation: retryGeneration,
          signal: controller.signal
        }))
      };
    }
  });
  return manager;
}

const expectedLease = () => expect.objectContaining({
  generation: 7,
  signal: expect.any(AbortSignal)
});

const fallbackTaskHandle = "hud_ZmFsbGJhY2staGFuZGxlLTEyMzQ";

function createHandlers(
  progressClient: Parameters<typeof createToolHandlers>[0]["progressClient"],
  companionManager: CompanionManager = createManager(),
  createFallbackTaskHandle?: () => string
) {
  return createToolHandlers({
    progressClient,
    companionManager,
    fallbackTaskHandle,
    ...(createFallbackTaskHandle === undefined ? {} : { createFallbackTaskHandle })
  });
}

function createRunningDeadlineManager(startupTimeoutMs: number): CompanionManager {
  const settings = { desiredState: "on" as const, startWithWindows: false, generation: 7 };
  const health: HudHealth = {
    service: "codex-progress-hud",
    pid: 4312,
    version: "0.2.0",
    protocolVersion: 3,
    visibility: "visible",
    instanceNonce: "deadline-instance",
    startedAt: "2026-09-02T00:00:00.000Z"
  };
  const store = {
    readSettings: vi.fn(async () => settings),
    readRuntime: vi.fn(async () => null)
  } as unknown as LifecycleStateStore;
  return createCompanionManager({
    store,
    client: {
      identity: vi.fn(async () => ({
        service: "codex-progress-hud" as const,
        protocolVersion: 3 as const
      })),
      health: vi.fn(async () => health),
      show: vi.fn(async () => undefined),
      hide: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined)
    },
    launcher: { spawnHud: vi.fn() },
    startupTimeoutMs,
    logger: { write: async () => undefined },
    diagnostics: {
      directory: "C:\\diagnostics",
      pluginVersion: "0.2.0",
      mcpVersion: "0.2.0",
      host: "127.0.0.1",
      port: 17_837,
      installManifestPath: "C:\\install.json",
      dataDirectoryPath: "C:\\data"
    }
  });
}

describe("MCP progress tool handlers", () => {
  const taskHandleA = "hud_aaaaaaaaaaaaaaaaaaaa";
  const taskHandleB = "hud_bbbbbbbbbbbbbbbbbbbb";

  it("requires the opaque Hook task handle and rejects caller-invented task ids", () => {
    expect(taskHandleSchema.safeParse(taskHandleA).success).toBe(true);
    expect(taskHandleSchema.safeParse("task-1").success).toBe(false);
    expect(progressReportSchema.safeParse({
      task_id: "task-1",
      title: "Fix login",
      phase: "testing"
    }).success).toBe(false);
    expect(progressReportSchema.safeParse({
      task_handle: taskHandleA,
      title: "Fix login",
      phase: "testing"
    }).success).toBe(true);
  });

  it("uses the MCP lease fallback for handle-free task writes", async () => {
    const submit = vi.fn(async () => ({
      task: { status: "running" },
      eta: null
    }));
    const status = vi.fn(async () => ({
      task: { id: taskHandleA, title: "Selected task", status: "running" },
      eta: null
    }));
    const handlers = createHandlers({ submit, status });

    const result = await handlers.progressReport({
      title: "Fallback target",
      phase: "testing"
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, associationSource: "mcp_lease" });
    expect(result.structuredContent).not.toHaveProperty("taskHandle");
    expect(JSON.stringify(result.structuredContent)).not.toContain(fallbackTaskHandle);
    expect(JSON.stringify(result.structuredContent)).not.toContain("owner-nonce");
    expect(JSON.stringify(result.structuredContent)).not.toContain("secret-token");
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: fallbackTaskHandle }),
      expect.anything()
    );
    expect(status).not.toHaveBeenCalled();
  });

  it("submits each semantic report to exactly the supplied opaque handle", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const handlers = createHandlers({ submit, status: vi.fn() });

    await handlers.progressReport({ task_handle: taskHandleA, phase: "first" });
    await handlers.progressReport({ task_handle: taskHandleB, phase: "second" });

    expect(submit).toHaveBeenNthCalledWith(1, expect.objectContaining({ taskId: taskHandleA }), expect.anything());
    expect(submit).toHaveBeenNthCalledWith(2, expect.objectContaining({ taskId: taskHandleB }), expect.anything());
  });

  it("exposes validation observation as a bounded report before outcome claims", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const handlers = createHandlers({ submit, status: vi.fn() });

    const result = await handlers.validationObserved({
      task_handle: taskHandleA,
      result: "passed"
    });

    expect(result.isError).toBeUndefined();
    expect(submit).toHaveBeenCalledWith({
      taskId: taskHandleA,
      event: { type: "validation_observed", result: "passed" }
    }, expectedLease());
  });

  it("omits titles from controls and semantic reports unless the caller supplies one", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const handlers = createHandlers({ submit, status: vi.fn() });

    await handlers.trackingPause({ task_handle: taskHandleA });
    await handlers.progressReport({ task_handle: taskHandleA, phase: "testing" });
    await handlers.taskOutcome({
      task_handle: taskHandleA,
      outcome: "blocked",
      verified: false
    });
    await handlers.progressReport({
      task_handle: taskHandleA,
      title: "Explicit replacement",
      phase: "verification"
    });

    expect(submit).toHaveBeenNthCalledWith(1, {
      taskId: taskHandleA,
      event: { type: "tracking_paused" }
    }, expectedLease());
    expect(submit).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ title: expect.anything() }), expectedLease());
    expect(submit).toHaveBeenNthCalledWith(3, expect.not.objectContaining({ title: expect.anything() }), expectedLease());
    expect(submit).toHaveBeenNthCalledWith(4, expect.objectContaining({
      title: "Explicit replacement"
    }), expectedLease());
  });

  it("preserves downstream TASK_NOT_FOUND for an explicit stale control handle", async () => {
    const handlers = createHandlers({
      submit: vi.fn(async () => {
        throw new HudClientError("TASK_NOT_FOUND", "unknown task handle");
      }),
      status: vi.fn()
    });

    const result = await handlers.trackingStop({ task_handle: taskHandleB });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      associationSource: "explicit",
      code: "TASK_NOT_FOUND"
    });
  });

  it("keeps pause, resume, and stop controls per handle and never treats them as Codex execution controls", async () => {
    const status = vi.fn();
    const submit = vi.fn(async (envelope) => ({
      task: { status: envelope.event.type === "tracking_stopped" ? "stopped" : "paused" },
      eta: null
    }));
    const handlers = createHandlers({ submit, status: vi.fn() });

    await handlers.trackingPause({ task_handle: taskHandleA });
    await handlers.trackingPause({ task_handle: taskHandleA });
    await handlers.trackingResume({ task_handle: taskHandleA });
    await handlers.trackingStop({ task_handle: taskHandleB });

    expect(submit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      taskId: taskHandleA,
      event: { type: "tracking_paused" }
    }), expect.anything());
    expect(submit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      taskId: taskHandleA,
      event: { type: "tracking_paused" }
    }), expect.anything());
    expect(submit).toHaveBeenNthCalledWith(3, expect.objectContaining({
      taskId: taskHandleA,
      event: { type: "tracking_resumed" }
    }), expect.anything());
    expect(submit).toHaveBeenNthCalledWith(4, expect.objectContaining({
      taskId: taskHandleB,
      event: { type: "tracking_stopped" }
    }), expect.anything());
    expect(status).not.toHaveBeenCalled();
  });

  it.each([
    ["tracking_start", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.trackingStart({ title: "Fallback task" }), { type: "tracking_started" }],
    ["progress_report", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.progressReport({ phase: "testing" }), { type: "model_progress", phase: "testing" }]
  ] as const)("uses the fallback handle for handle-free %s", async (_name, invoke, expectedEvent) => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const handlers = createHandlers({ submit, status: vi.fn() });

    const result = await invoke(handlers);

    expect(result.structuredContent).toMatchObject({ ok: true, associationSource: "mcp_lease" });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: fallbackTaskHandle, event: expectedEvent }),
      expect.anything()
    );
  });

  it.each([
    "ended_unknown",
    "completed_unverified",
    "succeeded_verified",
    "failed",
    "interrupted"
  ] as const)("rotates the handle-free fallback after a %s start and routes later reports to it", async (terminalStatus) => {
    const calls: Array<{ taskId: string; event: unknown }> = [];
    const submit = vi.fn(async (envelope) => {
      calls.push({ taskId: envelope.taskId, event: envelope.event });
      return {
        task: {
          id: envelope.taskId,
          title: calls.length === 1 ? "Finished task" : "New task",
          status: calls.length === 1 ? terminalStatus : "running"
        },
        eta: null
      };
    });
    const handlers = createHandlers({ submit, status: vi.fn() });

    await handlers.trackingStart({ title: "Restart task" });
    await handlers.progressReport({ phase: "after restart" });

    expect(calls).toHaveLength(3);
    expect(calls[0]?.taskId).toBe(fallbackTaskHandle);
    expect(calls[1]?.taskId).toMatch(/^hud_[A-Za-z0-9_-]{20,96}$/u);
    expect(calls[1]?.taskId).not.toBe(fallbackTaskHandle);
    expect(calls[2]?.taskId).toBe(calls[1]?.taskId);
  });

  it("restarts a terminal fallback after an explicit event rejection", async () => {
    const calls: string[] = [];
    const handlers = createHandlers({
      submit: async (envelope) => {
        calls.push(envelope.taskId);
        if (envelope.taskId === fallbackTaskHandle) throw new HudClientError("EVENT_NOT_APPLIED", "terminal");
        return { task: { id: envelope.taskId, status: "running" }, eta: null };
      },
      status: async () => ({ task: { id: fallbackTaskHandle, status: "succeeded_verified" }, eta: null })
    });
    const result = await handlers.trackingStart({ title: "Next task" });
    expect(result.isError).not.toBe(true);
    await handlers.progressReport({ phase: "new work" });
    expect(calls).toHaveLength(3);
    expect(calls[1]).not.toBe(fallbackTaskHandle);
    expect(calls[2]).toBe(calls[1]);
  });

  it("does not rotate when rejected work lacks terminal evidence", async () => {
    const calls: string[] = [];
    const handlers = createHandlers({
      submit: async (envelope) => {
        calls.push(envelope.taskId);
        throw new HudClientError("EVENT_NOT_APPLIED", "rejected");
      },
      status: async () => ({ task: { id: fallbackTaskHandle, status: "running" }, eta: null })
    });
    expect((await handlers.trackingStart({})).isError).toBe(true);
    expect(calls).toEqual([fallbackTaskHandle]);
  });

  it("serializes simultaneous handle-free starts without creating duplicate replacement tasks", async () => {
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    const submit = vi.fn(async (envelope: { taskId: string }) => {
      calls.push(envelope.taskId);
      if (calls.length === 1) {
        await firstStarted;
        return { task: { id: envelope.taskId, status: "succeeded_verified" }, eta: null };
      }
      return { task: { id: envelope.taskId, status: "running" }, eta: null };
    });
    const handlers = createHandlers({ submit, status: vi.fn() });

    const first = handlers.trackingStart({ title: "First restart" });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const second = handlers.trackingStart({ title: "Second restart" });
    await Promise.resolve();
    expect(submit).toHaveBeenCalledOnce();

    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toHaveLength(3);
    expect(new Set(calls).size).toBe(2);
    expect(calls[0]).toBe(fallbackTaskHandle);
    expect(calls[1]).toBe(calls[2]);
  });

  it("reuses one replacement candidate when the write manager retries the terminal start", async () => {
    const calls: string[] = [];
    let candidateAttempts = 0;
    const replacement = "hud_cccccccccccccccccccc";
    const submit = vi.fn(async (
      envelope: { taskId: string },
      options: { signal?: AbortSignal }
    ) => {
      calls.push(envelope.taskId);
      if (envelope.taskId === fallbackTaskHandle) {
        return { task: { id: envelope.taskId, status: "failed" }, eta: null };
      }
      if (candidateAttempts++ === 0) {
        throw new HudClientError("OFFLINE", "retry terminal start");
      }
      return { task: { id: envelope.taskId, status: "running" }, eta: null };
    });
    const handlers = createHandlers(
      { submit, status: vi.fn() },
      undefined,
      () => replacement
    );

    await handlers.trackingStart({ title: "Retry restart" });
    await handlers.progressReport({ phase: "after retry" });

    expect(calls).toEqual([
      fallbackTaskHandle,
      replacement,
      fallbackTaskHandle,
      replacement,
      replacement
    ]);
    expect(submit.mock.calls[1]?.[1]?.signal).toBe(submit.mock.calls[3]?.[1]?.signal);
  });

  it("does not rotate on progress after a terminal fallback write", async () => {
    const calls: string[] = [];
    const submit = vi.fn(async (envelope) => {
      calls.push(envelope.taskId);
      return { task: { id: envelope.taskId, status: "succeeded_verified" }, eta: null };
    });
    const handlers = createHandlers({ submit, status: vi.fn() });

    await handlers.progressReport({ phase: "late one" });
    await handlers.progressReport({ phase: "late two" });

    expect(calls).toEqual([fallbackTaskHandle, fallbackTaskHandle]);
  });

  it("keeps the old fallback when the replacement start fails", async () => {
    const calls: string[] = [];
    const replacement = "hud_dddddddddddddddddddd";
    const submit = vi.fn(async (envelope) => {
      calls.push(envelope.taskId);
      if (calls.length === 1) return { task: { id: envelope.taskId, status: "failed" }, eta: null };
      if (calls.length === 2) throw new HudClientError("REQUEST_TIMEOUT", "replacement timed out");
      return { task: { id: envelope.taskId, status: "running" }, eta: null };
    });
    const handlers = createHandlers(
      { submit, status: vi.fn() },
      undefined,
      () => replacement
    );

    const result = await handlers.trackingStart({ title: "Failed restart" });
    await handlers.progressReport({ phase: "still old" });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([fallbackTaskHandle, replacement, fallbackTaskHandle]);
  });

  it("keeps the old fallback when a handle-free start is suppressed", async () => {
    const submit = vi.fn(async (envelope) => ({
      task: { id: envelope.taskId, status: "running" },
      eta: null
    }));
    let writeCalls = 0;
    const companionManager = createManager({
      executeWrite: vi.fn(async (_reason, operation) => {
        writeCalls += 1;
        if (writeCalls === 1) return { kind: "suppressed" as const, code: "MANUALLY_DISABLED" as const };
        return {
          kind: "completed" as const,
          value: await operation(() => ({ generation: 7, signal: new AbortController().signal }))
        };
      })
    });
    const handlers = createHandlers({ submit, status: vi.fn() }, companionManager);

    await handlers.trackingStart({ title: "Suppressed restart" });
    await handlers.progressReport({ phase: "after suppression" });

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: fallbackTaskHandle }),
      expect.anything()
    );
  });

  it("does not retarget an already delayed report when a later start rotates the fallback", async () => {
    let releaseReport!: () => void;
    const reportStarted = new Promise<void>((resolve) => { releaseReport = resolve; });
    const calls: Array<{ taskId: string; event: string }> = [];
    const submit = vi.fn(async (envelope) => {
      calls.push({ taskId: envelope.taskId, event: envelope.event.type });
      if (envelope.event.type === "model_progress") {
        await reportStarted;
        return { task: { id: envelope.taskId, status: "succeeded_verified" }, eta: null };
      }
      if (envelope.taskId === fallbackTaskHandle) {
        return { task: { id: envelope.taskId, status: "succeeded_verified" }, eta: null };
      }
      return { task: { id: envelope.taskId, status: "running" }, eta: null };
    });
    const handlers = createHandlers({ submit, status: vi.fn() });

    const delayedReport = handlers.progressReport({ phase: "delayed" });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const restart = handlers.trackingStart({ title: "New work" });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
    releaseReport();
    await Promise.all([delayedReport, restart]);

    expect(calls[0]).toEqual({ taskId: fallbackTaskHandle, event: "model_progress" });
    expect(calls[1]?.taskId).toBe(fallbackTaskHandle);
    expect(calls[2]?.taskId).not.toBe(fallbackTaskHandle);
  });

  it.each([
    ["tracking_pause", (handlers: ReturnType<typeof createHandlers>) => handlers.trackingPause({})],
    ["tracking_resume", (handlers: ReturnType<typeof createHandlers>) => handlers.trackingResume({})],
    ["tracking_stop", (handlers: ReturnType<typeof createHandlers>) => handlers.trackingStop({})],
    ["validation_observed", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.validationObserved({ result: "passed" })],
    ["task_outcome", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.taskOutcome({ outcome: "completed", verified: false })]
  ] as const)("uses the fallback handle and preserves TASK_NOT_FOUND for handle-free %s", async (_name, invoke) => {
    const submit = vi.fn(async () => {
      throw new HudClientError("TASK_NOT_FOUND", "unknown task handle");
    });
    const status = vi.fn(async () => ({
      task: { id: taskHandleA, title: "Selected task", status: "running" },
      eta: null
    }));
    const handlers = createHandlers({ submit, status });

    const result = await invoke(handlers);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      associationSource: "mcp_lease",
      code: "TASK_NOT_FOUND"
    });
    expect(result.structuredContent).not.toHaveProperty("taskHandle");
    expect(JSON.stringify(result.structuredContent)).not.toContain(fallbackTaskHandle);
    expect(JSON.stringify(result.structuredContent)).not.toContain("owner-nonce");
    expect(JSON.stringify(result.structuredContent)).not.toContain("secret-token");
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: fallbackTaskHandle }),
      expect.anything()
    );
    expect(status).not.toHaveBeenCalled();
  });

  it.each([
    ["tracking_start", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.trackingStart({ task_handle: "task-1" })],
    ["progress_report", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.progressReport({ task_handle: "task-1", phase: "testing" })],
    ["tracking_pause", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.trackingPause({ task_handle: "task-1" })],
    ["tracking_resume", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.trackingResume({ task_handle: "task-1" })],
    ["tracking_stop", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.trackingStop({ task_handle: "task-1" })],
    ["validation_observed", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.validationObserved({ task_handle: "task-1", result: "passed" })],
    ["task_outcome", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.taskOutcome({ task_handle: "task-1", outcome: "completed" })]
  ] as const)("rejects malformed explicit handles for %s before any write", async (_name, invoke) => {
    const submit = vi.fn();
    const companionManager = createManager();
    const handlers = createHandlers({ submit, status: vi.fn() }, companionManager);

    const result = await invoke(handlers);

    expect(result.isError).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(companionManager.ensureForWrite).not.toHaveBeenCalled();
  });

  it.each([
    ["trackingStart", (handlers: ReturnType<typeof createHandlers>) => handlers.trackingStart(null)],
    ["trackingPause", (handlers: ReturnType<typeof createHandlers>) => handlers.trackingPause(null)],
    ["trackingResume", (handlers: ReturnType<typeof createHandlers>) => handlers.trackingResume(null)],
    ["trackingStop", (handlers: ReturnType<typeof createHandlers>) => handlers.trackingStop(null)]
  ] as const)("rejects whole-input null for %s without association or writes", async (_name, invoke) => {
    const submit = vi.fn();
    const companionManager = createManager();
    const handlers = createHandlers({ submit, status: vi.fn() }, companionManager);

    const result = await invoke(handlers);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid");
    expect(result.structuredContent).toBeUndefined();
    expect(submit).not.toHaveBeenCalled();
    expect(companionManager.ensureForWrite).not.toHaveBeenCalled();
  });

  it.each([
    ["tracking_start", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.trackingStart({ task_handle: taskHandleA })],
    ["progress_report", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.progressReport({ task_handle: taskHandleA, phase: "testing" })],
    ["tracking_pause", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.trackingPause({ task_handle: taskHandleA })],
    ["tracking_resume", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.trackingResume({ task_handle: taskHandleA })],
    ["tracking_stop", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.trackingStop({ task_handle: taskHandleA })],
    ["validation_observed", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.validationObserved({ task_handle: taskHandleA, result: "passed" })],
    ["task_outcome", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.taskOutcome({ task_handle: taskHandleA, outcome: "completed" })]
  ] as const)("uses a valid explicit handle for %s", async (_name, invoke) => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const handlers = createHandlers({ submit, status: vi.fn() });

    const result = await invoke(handlers);

    expect(result.structuredContent).toMatchObject({ ok: true, associationSource: "explicit" });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: taskHandleA }),
      expect.anything()
    );
  });

  it("keeps status tools read-only without an association lookup", async () => {
    const progressClient = { submit: vi.fn(), status: vi.fn(async () => ({ task: null, eta: null })) };
    const companionManager = createManager();
    const handlers = createHandlers(progressClient, companionManager);

    await handlers.taskStatus();
    await handlers.trackingStatus();

    expect(progressClient.submit).not.toHaveBeenCalled();
    expect(progressClient.status).toHaveBeenCalledTimes(2);
    expect(companionManager.ensureForWrite).not.toHaveBeenCalled();
  });

  it("carries the manager generation lease through the actual event submit", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const companionManager = createManager();
    const handlers = createHandlers({ submit, status: vi.fn() }, companionManager);

    await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Generation lease",
      phase: "submitting"
    });

    expect(companionManager.executeWrite).toHaveBeenCalledWith(
      "progress_report",
      expect.any(Function)
    );
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "hud_aaaaaaaaaaaaaaaaaaaa" }),
      expect.objectContaining({ generation: 7, signal: expect.any(AbortSignal) })
    );
  });
  it("normalizes a progress report into a minimal model event", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const handlers = createHandlers({ submit, status: vi.fn() });

    const result = await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      phase: "testing",
      current_step: "Run integration tests",
      progress: 0.6,
      confidence: 0.7,
      eta_low_seconds: 200,
      eta_high_seconds: 400
    });

    expect(submit).toHaveBeenCalledWith({
      taskId: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      event: {
        type: "model_progress",
        phase: "testing",
        currentStep: "Run integration tests",
        progress: 0.6,
        confidence: 0.7,
        remainingSeconds: 300
      }
    }, expectedLease());
    expect(result.isError).toBeUndefined();
  });

  it("turns a waiting report into a waiting event without a fabricated percentage", async () => {
    const submit = vi.fn(async () => ({ task: { status: "waiting_approval" }, eta: null }));
    const handlers = createHandlers({ submit, status: vi.fn() });

    await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      phase: "dependency_install",
      current_step: "Allow npm install",
      waiting_for: "approval"
    });

    expect(submit).toHaveBeenCalledWith({
      taskId: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      event: {
        type: "waiting",
        reason: "approval",
        detail: "Allow npm install"
      }
    }, expectedLease());
  });

  it("rejects progress and confidence outside the public 0..1 contract", async () => {
    const handlers = createHandlers({ submit: vi.fn(), status: vi.fn() });

    const result = await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      phase: "testing",
      progress: 130,
      confidence: -1
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid progress report");
  });

  it("reports a verified completion without inventing validation evidence", async () => {
    const submit = vi.fn(async () => ({ task: { status: "succeeded_verified" }, eta: null }));
    const handlers = createHandlers({ submit, status: vi.fn() });

    await handlers.taskOutcome({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      outcome: "completed",
      verified: true,
      detail: "34 tests passed"
    });

    expect(submit).toHaveBeenCalledWith({
      taskId: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      event: {
        type: "model_outcome",
        outcome: "completed",
        verified: true,
        detail: "34 tests passed"
      }
    }, expectedLease());
  });

  it("returns a sanitized internal error for an unclassified write failure", async () => {
    const companionManager = createManager();
    const submit = vi.fn(async () => {
      throw new Error("malformed response token=secret");
    });
    const handlers = createHandlers({ submit, status: vi.fn() }, companionManager);

    const result = await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("token=secret");
    expect(result.structuredContent).toEqual({
      ok: false,
      associationSource: "explicit",
      code: "INTERNAL_ERROR"
    });
    expect(companionManager.ensureForWrite).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("preserves a protocol mismatch code and gives upgrade/restart guidance", async () => {
    const companionManager = createManager({
      executeWrite: vi.fn(async () => {
        throw new HudClientError("VERSION_MISMATCH", "protocol rejected");
      })
    });
    const handlers = createHandlers({ submit: vi.fn(), status: vi.fn() }, companionManager);

    const result = await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      associationSource: "explicit",
      code: "VERSION_MISMATCH"
    });
    expect(result.content[0]?.text).toContain("Update the plugin and companion");
    expect(result.content[0]?.text).toContain("quit Codex");
    expect(result.content[0]?.text).toContain("reopen it");
    expect(result.content[0]?.text).not.toContain("Hook-enabled");
  });

  it("preserves a stale revision code from a semantic write", async () => {
    const companionManager = createManager({
      executeWrite: vi.fn(async () => {
        throw new HudClientError("STALE_REVISION", "stale task revision");
      })
    });
    const handlers = createHandlers({ submit: vi.fn(), status: vi.fn() }, companionManager);

    const result = await handlers.progressReport({
      task_handle: taskHandleA,
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      associationSource: "explicit",
      code: "STALE_REVISION"
    });
  });

  it("preserves a structured lifecycle client error from control handlers", async () => {
    const companionManager = createManager({
      open: vi.fn(async () => {
        throw new HudClientError("GENERATION_REJECTED", "stale lifecycle generation");
      })
    });
    const handlers = createHandlers({ submit: vi.fn(), status: vi.fn() }, companionManager);

    const result = await handlers.hudOpen();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ ok: false, code: "GENERATION_REJECTED" });
  });

  it("gives upgrade/restart guidance for a lifecycle-returned protocol mismatch", async () => {
    const companionManager = createManager({
      open: vi.fn(async () => ({
        desiredState: "on" as const,
        observedState: "incompatible" as const,
        code: "VERSION_MISMATCH" as const
      }))
    });
    const handlers = createHandlers({ submit: vi.fn(), status: vi.fn() }, companionManager);

    const result = await handlers.hudOpen();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      desiredState: "on",
      observedState: "incompatible",
      code: "VERSION_MISMATCH"
    });
    expect(result.content[0]?.text).toContain("Update the plugin and companion");
    expect(result.content[0]?.text).toContain("quit Codex");
    expect(result.content[0]?.text).toContain("reopen it");
  });

  it("starts tracking the supplied task without requiring a progress report", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const status = vi.fn(async () => ({ task: null, eta: null }));
    const handlers = createHandlers({ submit, status });

    const result = await handlers.trackingStart({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Implement controls"
    });

    expect(status).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith({
      taskId: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Implement controls",
      event: { type: "tracking_started" }
    }, expectedLease());
    expect(result.content[0]?.text).toContain("Tracking started");
  });

  it("controls the current task and exposes status as a read-only action", async () => {
    const submit = vi.fn(async (envelope) => ({
      task: { status: envelope.event.type === "tracking_stopped" ? "stopped" : "paused" },
      eta: null
    }));
    const status = vi.fn(async () => ({
      task: { id: "task-1", title: "Implement controls", status: "running" },
      eta: null
    }));
    const handlers = createHandlers({ submit, status });

    await handlers.trackingPause({ task_handle: "hud_aaaaaaaaaaaaaaaaaaaa" });
    await handlers.trackingResume({ task_handle: "hud_aaaaaaaaaaaaaaaaaaaa" });
    await handlers.trackingStop({ task_handle: "hud_aaaaaaaaaaaaaaaaaaaa" });
    const statusResult = await handlers.trackingStatus();

    expect(submit).toHaveBeenNthCalledWith(1, {
      taskId: "hud_aaaaaaaaaaaaaaaaaaaa",
      event: { type: "tracking_paused" }
    }, expectedLease());
    expect(submit).toHaveBeenNthCalledWith(2, {
      taskId: "hud_aaaaaaaaaaaaaaaaaaaa",
      event: { type: "tracking_resumed" }
    }, expectedLease());
    expect(submit).toHaveBeenNthCalledWith(3, {
      taskId: "hud_aaaaaaaaaaaaaaaaaaaa",
      event: { type: "tracking_stopped" }
    }, expectedLease());
    expect(statusResult.content[0]?.text).toContain('"status":"running"');
  });

  it.each([
    ["tracking_start", (handlers: ReturnType<typeof createHandlers>) =>
      handlers.trackingStart({ task_handle: "hud_aaaaaaaaaaaaaaaaaaaa", title: "Deadline control" })],
    ["tracking_pause", (handlers: ReturnType<typeof createHandlers>) => handlers.trackingPause({ task_handle: "hud_aaaaaaaaaaaaaaaaaaaa" })],
    ["tracking_resume", (handlers: ReturnType<typeof createHandlers>) => handlers.trackingResume({ task_handle: "hud_aaaaaaaaaaaaaaaaaaaa" })],
    ["tracking_stop", (handlers: ReturnType<typeof createHandlers>) => handlers.trackingStop({ task_handle: "hud_aaaaaaaaaaaaaaaaaaaa" })]
  ] as const)(
    "%s shares one 90ms deadline across status and a hanging submit",
    async (_name, invoke) => {
      const requestTimeouts: number[] = [];
      let accepted = false;
      const status = vi.fn(async (options) => {
        requestTimeouts.push(options?.timeoutMs ?? Number.POSITIVE_INFINITY);
        await new Promise((resolve_) => setTimeout(resolve_, 75));
        return {
          task: { id: "task-1", title: "Deadline control", status: "running" },
          eta: null
        };
      });
      const submit = vi.fn((_envelope, options) => new Promise<never>((_resolve, reject) => {
        requestTimeouts.push(options?.timeoutMs ?? Number.POSITIVE_INFINITY);
        const lateAcceptance = setTimeout(() => { accepted = true; }, 150);
        const cancel = () => {
          clearTimeout(lateAcceptance);
          reject(new HudClientError("REQUEST_CANCELLED", "deadline cancelled submit"));
        };
        if (options?.signal?.aborted) cancel();
        else options?.signal?.addEventListener("abort", cancel, { once: true });
      }));
      const handlers = createHandlers(
        { submit, status },
        createRunningDeadlineManager(90)
      );
      const startedAt = performance.now();

      const result = await Promise.race([
        invoke(handlers).then((value) => ({ kind: "resolved" as const, value })),
        new Promise<{ kind: "watchdog" }>((resolve_) =>
          setTimeout(() => resolve_({ kind: "watchdog" }), 300)
        )
      ]);
      const elapsedMs = performance.now() - startedAt;
      await new Promise((resolve_) => setTimeout(resolve_, 160));

      expect(result).toMatchObject({
        kind: "resolved",
        value: {
          isError: true,
          structuredContent: { ok: false, associationSource: "explicit", code: "START_TIMEOUT" }
        }
      });
      expect(elapsedMs).toBeLessThan(300);
      expect(requestTimeouts).toHaveLength(1);
      expect(requestTimeouts[0]).toBeLessThanOrEqual(90);
      expect(accepted).toBe(false);
    },
    2_000
  );

  it("keeps trackingStatus receiver-independent when registered or destructured", async () => {
    const status = vi.fn(async () => ({ task: null, eta: null }));
    const { trackingStatus } = createHandlers({ submit: vi.fn(), status });

    const result = await trackingStatus();

    expect(result.content[0]?.text).toContain('"task":null');
    expect(status).toHaveBeenCalledOnce();
  });

  it("maps lifecycle operations to exact structured HUD states", async () => {
    const companionManager = createManager();
    const handlers = createHandlers({ submit: vi.fn(), status: vi.fn() }, companionManager);

    await expect(handlers.hudOpen()).resolves.toMatchObject({
      content: [{ type: "text", text: "Progress HUD is open." }],
      structuredContent: { ok: true, desiredState: "on", observedState: "running" }
    });
    await expect(handlers.hudHide()).resolves.toMatchObject({
      content: [{ type: "text", text: "Progress HUD is hidden." }],
      structuredContent: { ok: true, desiredState: "on", observedState: "hidden" }
    });
    await expect(handlers.hudClose()).resolves.toMatchObject({
      content: [{ type: "text", text: "Progress HUD is closed." }],
      structuredContent: { ok: true, desiredState: "off", observedState: "stopped" }
    });
    expect(companionManager.open).toHaveBeenCalledOnce();
    expect(companionManager.hide).toHaveBeenCalledOnce();
    expect(companionManager.close).toHaveBeenCalledOnce();
  });

  it("returns lifecycle failures with their exact state and code", async () => {
    const companionManager = createManager({
      open: vi.fn(async () => ({
        desiredState: "on" as const,
        observedState: "port_conflict" as const,
        code: "PORT_CONFLICT" as const
      }))
    });
    const handlers = createHandlers({ submit: vi.fn(), status: vi.fn() }, companionManager);

    const result = await handlers.hudOpen();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      desiredState: "on",
      observedState: "port_conflict",
      code: "PORT_CONFLICT"
    });
  });

  it("keeps lifecycle status observational and preserves observed failures", async () => {
    const companionManager = createManager({
      status: vi.fn(async () => ({
        desiredState: "on" as const,
        observedState: "incompatible" as const,
        code: "VERSION_MISMATCH" as const
      }))
    });
    const progressClient = { submit: vi.fn(), status: vi.fn() };
    const handlers = createHandlers(progressClient, companionManager);

    const result = await handlers.hudStatus();

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      desiredState: "on",
      observedState: "incompatible",
      code: "VERSION_MISMATCH"
    });
    expect(companionManager.ensureForWrite).not.toHaveBeenCalled();
    expect(progressClient.status).not.toHaveBeenCalled();
  });

  it("returns the sanitized diagnostic report path", async () => {
    const companionManager = createManager();
    const handlers = createHandlers({ submit: vi.fn(), status: vi.fn() }, companionManager);

    const result = await handlers.hudDiagnose();

    expect(companionManager.diagnose).toHaveBeenCalledOnce();
    expect(result.structuredContent).toEqual({
      ok: true,
      reportPath: "C:\\diagnostics\\hud.md"
    });
  });

  it("returns inline diagnostics with an explicit unavailable-export warning", async () => {
    const manager = createManager({ diagnose: vi.fn(async () => ({
      exportStatus: "unavailable" as const, markdown: "# Safe diagnostic\n- Companion process: online"
    })) });
    const result = await createHandlers({ submit: vi.fn(), status: vi.fn() }, manager).hudDiagnose();
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, exportStatus: "unavailable",
      reportMarkdown: "# Safe diagnostic\n- Companion process: online" });
    expect(JSON.stringify(result.content)).toContain("file export unavailable");
    expect(result.structuredContent).not.toHaveProperty("reportPath");
  });

  it("suppresses a progress report successfully while manually disabled", async () => {
    const companionManager = createManager({
      ensureForWrite: vi.fn(async () => ({
        kind: "suppressed" as const,
        code: "MANUALLY_DISABLED" as const
      }))
    });
    const progressClient = { submit: vi.fn(), status: vi.fn() };
    const handlers = createHandlers(progressClient, companionManager);

    const result = await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(
      "HUD is manually closed; progress was not displayed."
    );
    expect(result.structuredContent).toEqual({
      ok: true,
      associationSource: "explicit",
      desiredState: "off",
      code: "MANUALLY_DISABLED"
    });
    expect(companionManager.ensureForWrite).toHaveBeenCalledWith("progress_report");
    expect(progressClient.submit).not.toHaveBeenCalled();
  });

  it("returns ensure failures before attempting the report", async () => {
    const companionManager = createManager({
      ensureForWrite: vi.fn(async () => ({
        kind: "error" as const,
        code: "COMPANION_NOT_INSTALLED" as const,
        snapshot: {
          desiredState: "on" as const,
          observedState: "stopped" as const,
          code: "COMPANION_NOT_INSTALLED" as const
        }
      }))
    });
    const progressClient = { submit: vi.fn(), status: vi.fn() };
    const handlers = createHandlers(progressClient, companionManager);

    const result = await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      associationSource: "explicit",
      desiredState: "on",
      observedState: "stopped",
      code: "COMPANION_NOT_INSTALLED"
    });
    expect(progressClient.submit).not.toHaveBeenCalled();
  });

  it("ensures tracking start before reading task state and can clear explicit off", async () => {
    const companionManager = createManager();
    const status = vi.fn(async () => ({ task: null, eta: null }));
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const handlers = createHandlers({ submit, status }, companionManager);

    await handlers.trackingStart({ task_handle: "hud_aaaaaaaaaaaaaaaaaaaa", title: "Implement controls" });

    expect(companionManager.ensureForWrite).toHaveBeenCalledWith("tracking_start");
    expect(status).not.toHaveBeenCalled();
  });

  it("tracking stop never closes the HUD", async () => {
    const companionManager = createManager();
    const handlers = createHandlers(
      {
        submit: vi.fn(async () => ({ task: { status: "stopped" }, eta: null })),
        status: vi.fn(async () => ({
          task: { id: "task-1", title: "Implement controls", status: "running" },
          eta: null
        }))
      },
      companionManager
    );

    await handlers.trackingStop({ task_handle: "hud_aaaaaaaaaaaaaaaaaaaa" });

    expect(companionManager.close).not.toHaveBeenCalled();
  });

  it("retries an OFFLINE report exactly once after a recovered startup", async () => {
    const companionManager = createManager();
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new HudClientError("OFFLINE", "companion disappeared"))
      .mockResolvedValueOnce({ task: { status: "running" }, eta: null });
    const handlers = createHandlers({ submit, status: vi.fn() }, companionManager);

    const result = await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBeUndefined();
    expect(companionManager.ensureForWrite).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["generic", new Error("unexpected response")],
    ["authentication", new HudClientError("AUTH_ERROR", "token rejected")],
    ["application", new TypeError("malformed application payload")]
  ])("does not retry a %s write failure", async (_kind, failure) => {
    const companionManager = createManager();
    const submit = vi.fn(async () => {
      throw failure;
    });
    const handlers = createHandlers({ submit, status: vi.fn() }, companionManager);

    const result = await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      associationSource: "explicit",
      code: failure instanceof HudClientError ? failure.code : "INTERNAL_ERROR"
    });
    expect(companionManager.ensureForWrite).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("does not invent a crashed state when observational status fails", async () => {
    const handlers = createHandlers({
      submit: vi.fn(),
      status: vi.fn(async () => {
        throw new HudClientError("OFFLINE", "not reachable");
      })
    });

    const result = await handlers.taskStatus();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      code: "OFFLINE"
    });
    expect(result.structuredContent).not.toHaveProperty("observedState");
  });

  it("does not invent a crashed state or retry after a second write failure", async () => {
    const companionManager = createManager();
    const submit = vi.fn(async () => {
      throw new HudClientError("OFFLINE", "not reachable");
    });
    const handlers = createHandlers({ submit, status: vi.fn() }, companionManager);

    const result = await handlers.progressReport({
      task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      associationSource: "explicit",
      code: "OFFLINE"
    });
    expect(result.structuredContent).not.toHaveProperty("observedState");
    expect(companionManager.ensureForWrite).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
  });
});
