import { describe, expect, it } from "vitest";
import { createInitialTask, reduceTask } from "../../src/core/reducer.js";

describe("task lifecycle reducer", () => {
  it("moves a task from idle to running when a turn starts", () => {
    const initial = createInitialTask("task-1", "Fix login", 1_000);
    const next = reduceTask(initial, { type: "turn_started" }, 2_000);

    expect(next.status).toBe("running");
    expect(next.startedAt).toBe(2_000);
    expect(next.lastActivityAt).toBe(2_000);
  });

  it("derives determinate progress from completed plan steps", () => {
    const initial = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      { type: "turn_started" },
      1_000
    );
    const next = reduceTask(
      initial,
      {
        type: "plan_updated",
        steps: [
          { title: "Inspect", status: "completed" },
          { title: "Implement", status: "in_progress" },
          { title: "Verify", status: "pending" }
        ]
      },
      2_000
    );

    expect(next.progress).toBeCloseTo(1 / 3);
    expect(next.currentStep).toBe("Implement");
  });

  it("represents approval as waiting instead of interruption", () => {
    const initial = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      { type: "turn_started" },
      1_000
    );
    const next = reduceTask(
      initial,
      { type: "waiting", reason: "approval", detail: "Allow npm install" },
      3_000
    );

    expect(next.status).toBe("waiting_approval");
    expect(next.currentStep).toBe("Allow npm install");
  });

  it("clamps cooperative model progress to a safe range", () => {
    const initial = createInitialTask("task-1", "Fix login", 1_000);
    const next = reduceTask(
      initial,
      {
        type: "model_progress",
        phase: "implementation",
        progress: 1.7,
        confidence: 0.8,
        remainingSeconds: 240
      },
      2_000
    );

    expect(next.progress).toBe(1);
    expect(next.modelEstimateSeconds).toBe(240);
    expect(next.modelConfidence).toBe(0.8);
  });

  it("does not let a model report override an explicit runtime failure", () => {
    const initial = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      { type: "runtime_failed", message: "connection lost" },
      2_000
    );
    const next = reduceTask(
      initial,
      { type: "model_progress", phase: "done", progress: 1, confidence: 1 },
      3_000
    );

    expect(next.status).toBe("failed");
    expect(next.statusDetail).toBe("connection lost");
  });

  it("distinguishes unverified completion from verified success", () => {
    const initial = createInitialTask("task-1", "Fix login", 1_000);
    const unverified = reduceTask(
      initial,
      { type: "model_outcome", outcome: "completed", verified: false },
      2_000
    );
    const verified = reduceTask(
      initial,
      { type: "model_outcome", outcome: "completed", verified: true },
      2_000
    );

    expect(unverified.status).toBe("completed_unverified");
    expect(verified.status).toBe("succeeded_verified");
  });

  it("keeps an explicit interruption terminal", () => {
    const initial = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      { type: "runtime_interrupted", message: "process exited" },
      2_000
    );
    const next = reduceTask(
      initial,
      { type: "model_outcome", outcome: "completed", verified: true },
      3_000
    );

    expect(next.status).toBe("interrupted");
  });
});
