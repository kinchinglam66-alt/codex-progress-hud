import { describe, expect, it } from "vitest";
import { estimateRemaining } from "../../src/core/eta.js";
import type { TaskSnapshot } from "../../src/core/types.js";

function runningSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "task-1",
    title: "Fix login",
    status: "running",
    statusDetail: undefined,
    phase: "implementation",
    currentStep: "Implement",
    progress: 0.5,
    plan: [],
    createdAt: 0,
    startedAt: 0,
    lastActivityAt: 300_000,
    completedAt: undefined,
    activeElapsedMs: 300_000,
    activeSince: undefined,
    modelEstimateSeconds: undefined,
    modelConfidence: undefined,
    ...overrides
  };
}

describe("ETA estimator", () => {
  it("derives a bounded range from observed plan throughput", () => {
    const estimate = estimateRemaining(runningSnapshot(), 300_000);

    expect(estimate).toEqual({
      lowSeconds: 215,
      highSeconds: 420,
      confidence: 0.6
    });
  });

  it("blends a confident executing-model estimate with plan throughput", () => {
    const estimate = estimateRemaining(
      runningSnapshot({ modelEstimateSeconds: 120, modelConfidence: 0.75 }),
      300_000
    );

    expect(estimate).toEqual({
      lowSeconds: 135,
      highSeconds: 200,
      confidence: 0.78
    });
  });

  it("uses a widened model-only range when measurable progress is unavailable", () => {
    const estimate = estimateRemaining(
      runningSnapshot({
        progress: undefined,
        activeElapsedMs: 0,
        modelEstimateSeconds: 600,
        modelConfidence: 0.5
      }),
      300_000
    );

    expect(estimate).toEqual({
      lowSeconds: 375,
      highSeconds: 960,
      confidence: 0.4
    });
  });

  it("widens and lowers confidence during exploration", () => {
    const estimate = estimateRemaining(
      runningSnapshot({ phase: "exploration" }),
      300_000
    );

    expect(estimate).toEqual({
      lowSeconds: 240,
      highSeconds: 580,
      confidence: 0.45
    });
  });

  it.each([
    "waiting_approval",
    "waiting_user",
    "paused",
    "stopped",
    "stalled_suspected",
    "completed_unverified",
    "succeeded_verified",
    "failed",
    "interrupted"
  ] as const)("returns no active ETA for %s", (status) => {
    expect(estimateRemaining(runningSnapshot({ status }), 300_000)).toBeNull();
  });

  it("does not extrapolate from zero completed progress", () => {
    expect(
      estimateRemaining(
        runningSnapshot({
          progress: 0,
          modelEstimateSeconds: undefined,
          modelConfidence: undefined
        }),
        300_000
      )
    ).toBeNull();
  });
});
