import { describe, expect, it, vi } from "vitest";
import type { CompanionManager } from "../../src/lifecycle/companion-manager.js";
import { HudClientError } from "../../src/mcp/report-client.js";
import { createToolHandlers } from "../../src/mcp/tools.js";

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
    try {
      return {
        kind: "completed" as const,
        value: await operation({ generation: ensured.generation, signal: controller.signal })
      };
    } catch (error) {
      if (!(error instanceof HudClientError) || error.code !== "OFFLINE") throw error;
      ensured = await manager.ensureForWrite(reason);
      if (ensured.kind !== "ready") return ensured;
      return {
        kind: "completed" as const,
        value: await operation({ generation: ensured.generation, signal: controller.signal })
      };
    }
  });
  return manager;
}

const expectedLease = () => expect.objectContaining({
  generation: 7,
  signal: expect.any(AbortSignal)
});

function createHandlers(
  progressClient: Parameters<typeof createToolHandlers>[0]["progressClient"],
  companionManager: CompanionManager = createManager()
) {
  return createToolHandlers({ progressClient, companionManager });
}

describe("MCP progress tool handlers", () => {
  it("carries the manager generation lease through the actual event submit", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const companionManager = createManager();
    const handlers = createHandlers({ submit, status: vi.fn() }, companionManager);

    await handlers.progressReport({
      task_id: "generation-7",
      title: "Generation lease",
      phase: "submitting"
    });

    expect(companionManager.executeWrite).toHaveBeenCalledWith(
      "progress_report",
      expect.any(Function)
    );
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "generation-7" }),
      expect.objectContaining({ generation: 7, signal: expect.any(AbortSignal) })
    );
  });
  it("normalizes a progress report into a minimal model event", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const handlers = createHandlers({ submit, status: vi.fn() });

    const result = await handlers.progressReport({
      task_id: "task-1",
      title: "Fix login",
      phase: "testing",
      current_step: "Run integration tests",
      progress: 0.6,
      confidence: 0.7,
      eta_low_seconds: 200,
      eta_high_seconds: 400
    });

    expect(submit).toHaveBeenCalledWith({
      taskId: "task-1",
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
      task_id: "task-1",
      title: "Fix login",
      phase: "dependency_install",
      current_step: "Allow npm install",
      waiting_for: "approval"
    });

    expect(submit).toHaveBeenCalledWith({
      taskId: "task-1",
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
      task_id: "task-1",
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
      task_id: "task-1",
      title: "Fix login",
      outcome: "completed",
      verified: true,
      detail: "34 tests passed"
    });

    expect(submit).toHaveBeenCalledWith({
      taskId: "task-1",
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
      task_id: "task-1",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("token=secret");
    expect(result.structuredContent).toEqual({ ok: false, code: "INTERNAL_ERROR" });
    expect(companionManager.ensureForWrite).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("starts tracking the supplied task without requiring a progress report", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const status = vi.fn(async () => ({ task: null, eta: null }));
    const handlers = createHandlers({ submit, status });

    const result = await handlers.trackingStart({
      task_id: "task-1",
      title: "Implement controls"
    });

    expect(status).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith({
      taskId: "task-1",
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

    await handlers.trackingPause({});
    await handlers.trackingResume({});
    await handlers.trackingStop({});
    const statusResult = await handlers.trackingStatus();

    expect(submit).toHaveBeenNthCalledWith(1, {
      taskId: "task-1",
      title: "Implement controls",
      event: { type: "tracking_paused" }
    }, expectedLease());
    expect(submit).toHaveBeenNthCalledWith(2, {
      taskId: "task-1",
      title: "Implement controls",
      event: { type: "tracking_resumed" }
    }, expectedLease());
    expect(submit).toHaveBeenNthCalledWith(3, {
      taskId: "task-1",
      title: "Implement controls",
      event: { type: "tracking_stopped" }
    }, expectedLease());
    expect(statusResult.content[0]?.text).toContain('"status":"running"');
  });

  it("keeps trackingStatus receiver-independent when registered or destructured", async () => {
    const status = vi.fn(async () => ({ task: null, eta: null }));
    const { trackingStatus } = createHandlers({ submit: vi.fn(), status });

    const result = await trackingStatus();

    expect(result.content[0]?.text).toContain('"task":null');
    expect(status).toHaveBeenCalledOnce();
  });

  it("returns a clear error when a control needs a current task but none exists", async () => {
    const handlers = createHandlers({
      submit: vi.fn(),
      status: vi.fn(async () => ({ task: null, eta: null }))
    });

    const result = await handlers.trackingPause({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("No active task to control.");
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
      task_id: "task-1",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(
      "HUD is manually closed; progress was not displayed."
    );
    expect(result.structuredContent).toEqual({
      ok: true,
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
      task_id: "task-1",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
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

    await handlers.trackingStart({ task_id: "task-1", title: "Implement controls" });

    expect(companionManager.ensureForWrite).toHaveBeenCalledWith("tracking_start");
    expect(vi.mocked(companionManager.ensureForWrite).mock.invocationCallOrder[0]).toBeLessThan(
      status.mock.invocationCallOrder[0]!
    );
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

    await handlers.trackingStop({});

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
      task_id: "task-1",
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
      task_id: "task-1",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ ok: false, code: "INTERNAL_ERROR" });
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
    expect(result.structuredContent).toEqual({ ok: false, code: "INTERNAL_ERROR" });
    expect(result.structuredContent).not.toHaveProperty("observedState");
  });

  it("does not invent a crashed state or retry after a second write failure", async () => {
    const companionManager = createManager();
    const submit = vi.fn(async () => {
      throw new HudClientError("OFFLINE", "not reachable");
    });
    const handlers = createHandlers({ submit, status: vi.fn() }, companionManager);

    const result = await handlers.progressReport({
      task_id: "task-1",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ ok: false, code: "INTERNAL_ERROR" });
    expect(result.structuredContent).not.toHaveProperty("observedState");
    expect(companionManager.ensureForWrite).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
  });
});
