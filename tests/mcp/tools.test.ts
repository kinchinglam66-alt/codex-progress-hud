import { describe, expect, it, vi } from "vitest";
import { createToolHandlers } from "../../src/mcp/tools.js";

describe("MCP progress tool handlers", () => {
  it("normalizes a progress report into a minimal model event", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const handlers = createToolHandlers({ submit, status: vi.fn() });

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
    });
    expect(result.isError).toBeUndefined();
  });

  it("turns a waiting report into a waiting event without a fabricated percentage", async () => {
    const submit = vi.fn(async () => ({ task: { status: "waiting_approval" }, eta: null }));
    const handlers = createToolHandlers({ submit, status: vi.fn() });

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
    });
  });

  it("rejects progress and confidence outside the public 0..1 contract", async () => {
    const handlers = createToolHandlers({ submit: vi.fn(), status: vi.fn() });

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
    const handlers = createToolHandlers({ submit, status: vi.fn() });

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
    });
  });

  it("returns a safe diagnostic when the companion is offline", async () => {
    const handlers = createToolHandlers({
      submit: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1 token=secret");
      }),
      status: vi.fn()
    });

    const result = await handlers.progressReport({
      task_id: "task-1",
      title: "Fix login",
      phase: "testing"
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "Progress HUD is not reachable. Start the local companion and retry."
    );
  });

  it("starts tracking the supplied task without requiring a progress report", async () => {
    const submit = vi.fn(async () => ({ task: { status: "running" }, eta: null }));
    const status = vi.fn(async () => ({ task: null, eta: null }));
    const handlers = createToolHandlers({ submit, status });

    const result = await handlers.trackingStart({
      task_id: "task-1",
      title: "Implement controls"
    });

    expect(status).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith({
      taskId: "task-1",
      title: "Implement controls",
      event: { type: "tracking_started" }
    });
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
    const handlers = createToolHandlers({ submit, status });

    await handlers.trackingPause({});
    await handlers.trackingResume({});
    await handlers.trackingStop({});
    const statusResult = await handlers.trackingStatus();

    expect(submit).toHaveBeenNthCalledWith(1, {
      taskId: "task-1",
      title: "Implement controls",
      event: { type: "tracking_paused" }
    });
    expect(submit).toHaveBeenNthCalledWith(2, {
      taskId: "task-1",
      title: "Implement controls",
      event: { type: "tracking_resumed" }
    });
    expect(submit).toHaveBeenNthCalledWith(3, {
      taskId: "task-1",
      title: "Implement controls",
      event: { type: "tracking_stopped" }
    });
    expect(statusResult.content[0]?.text).toContain('"status":"running"');
  });

  it("returns a clear error when a control needs a current task but none exists", async () => {
    const handlers = createToolHandlers({
      submit: vi.fn(),
      status: vi.fn(async () => ({ task: null, eta: null }))
    });

    const result = await handlers.trackingPause({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("No active task to control.");
  });
});
