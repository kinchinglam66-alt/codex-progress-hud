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
      confidence: 0.6,
      confidenceClass: "medium",
      signals: ["plan"]
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
      confidence: 0.78,
      confidenceClass: "high",
      signals: ["plan", "model"]
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
      confidence: 0.4,
      confidenceClass: "low",
      signals: ["model"]
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
      confidence: 0.45,
      confidenceClass: "low",
      signals: ["plan"]
    });
  });

  it.each([
    "waiting_approval",
    "waiting_user",
    "quiescent",
    "paused",
    "stopped",
    "stalled_suspected",
    "disconnected_suspected",
    "ended_unknown",
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

  it("widens and lowers confidence for a late attachment", () => {
    const estimate = estimateRemaining(
      runningSnapshot({ trackingOrigin: "late_attach", estimateVolatility: 0 }),
      300_000
    );

    expect(estimate).toEqual({
      lowSeconds: 155,
      highSeconds: 585,
      confidence: 0.45,
      confidenceClass: "low",
      signals: ["plan"]
    });
  });

  it("widens the interval after a plan rewrite or validation failure", () => {
    const estimate = estimateRemaining(
      runningSnapshot({ estimateVolatility: 0.5 }),
      300_000
    );

    expect(estimate).toEqual({
      lowSeconds: 165,
      highSeconds: 540,
      confidence: 0.6,
      confidenceClass: "medium",
      signals: ["plan"]
    });
  });

  it("uses active work time only when the clock advances", () => {
    const active = runningSnapshot({ activeElapsedMs: 0, activeSince: 240_000 });
    const atFiveMinutes = estimateRemaining(active, 300_000);
    const atPausedWallClock = estimateRemaining(
      { ...active, status: "quiescent", activeElapsedMs: 120_000, activeSince: undefined },
      3_600_000
    );

    expect(atFiveMinutes).toEqual({
      lowSeconds: 45,
      highSeconds: 85,
      confidence: 0.6,
      confidenceClass: "medium",
      signals: ["plan"]
    });
    expect(atPausedWallClock).toBeNull();
  });

  it("blends calibration lower and upper bounds instead of only its midpoint", () => {
    const estimate = estimateRemaining(
      runningSnapshot({ estimateVolatility: 0 }),
      300_000,
      { lowSeconds: 50, highSeconds: 250, confidence: 0.5 }
    );

    expect(estimate).toEqual({
      lowSeconds: 175,
      highSeconds: 380,
      confidence: 0.58,
      confidenceClass: "medium",
      signals: ["plan", "calibration"]
    });
    expect(estimate!.lowSeconds).toBeLessThanOrEqual(estimate!.highSeconds);
  });

  it.each([
    [0.2, "low"],
    [0.8, "medium"],
    [1, "high"]
  ] as const)("classifies confidence %s as %s", (confidence, confidenceClass) => {
    const estimate = estimateRemaining(
      runningSnapshot({
        progress: undefined,
        activeElapsedMs: 0,
        modelEstimateSeconds: 100,
        modelConfidence: confidence
      }),
      300_000
    );

    expect(estimate?.confidenceClass).toBe(confidenceClass);
  });
});
