import { describe, expect, it } from "vitest";
import { projectCountdown, type CountdownPrediction } from "../../src/ui/countdown.js";

const prediction: CountdownPrediction = {
  remainingSeconds: 3661,
  errorPercent: 10,
  observedActiveSeconds: 100
};

describe("bounded countdown projection", () => {
  it("formats running time as HH:MM:SS and keeps hours beyond 24", () => {
    expect(projectCountdown({ prediction, activeSeconds: 101, state: "running" })).toEqual({
      timeText: "01:01:00",
      uncertaintyText: "±11%",
      status: "running"
    });
    expect(projectCountdown({
      prediction: { remainingSeconds: 90_061, errorPercent: 1, observedActiveSeconds: 0 },
      activeSeconds: 0,
      state: "running"
    }).timeText).toBe("25:01:01");
  });

  it("ceils a nonzero fractional remaining second for display", () => {
    expect(projectCountdown({
      prediction: { remainingSeconds: 2.01, errorPercent: 0, observedActiveSeconds: 0 },
      activeSeconds: 0.5,
      state: "running"
    }).timeText).toBe("00:00:02");
  });

  it("recomputes percentage conservatively from fixed absolute uncertainty", () => {
    expect(projectCountdown({
      prediction: { remainingSeconds: 100, errorPercent: 10, observedActiveSeconds: 0 },
      activeSeconds: 50,
      state: "running"
    }).uncertaintyText).toBe("±20%");
  });

  it.each(["waiting", "paused"] as const)("uses owner-supplied frozen active time while %s", (state) => {
    const input = { prediction: { remainingSeconds: 600, errorPercent: 10, observedActiveSeconds: 0 }, state };
    expect(projectCountdown({ ...input, activeSeconds: 120 })).toMatchObject({ timeText: "00:08:00", status: state });
    expect(projectCountdown({ ...input, activeSeconds: 120 })).toMatchObject({ timeText: "00:08:00", status: state });
  });

  it("allows a new prediction to move in either direction", () => {
    const forward = projectCountdown({ prediction: { ...prediction, remainingSeconds: 5000 }, activeSeconds: 106, state: "running" });
    const backward = projectCountdown({ prediction: { ...prediction, remainingSeconds: 5 }, activeSeconds: 106, state: "running" });
    expect(forward.timeText).toBe("01:23:14");
    expect(backward.status).toBe("overdue");
  });

  it("reports completion only when the owner supplies completed state", () => {
    expect(projectCountdown({ prediction, activeSeconds: 9999, state: "completed" })).toEqual({
      timeText: "00:00:00",
      uncertaintyText: "Completed",
      status: "completed"
    });
  });

  it("reports overdue when time reaches zero without completion", () => {
    expect(projectCountdown({
      prediction: { remainingSeconds: 10, errorPercent: 20, observedActiveSeconds: 0 },
      activeSeconds: 10,
      state: "running"
    })).toEqual({ timeText: "00:00:00", uncertaintyText: "±20%", status: "overdue" });
  });

  it("returns unknown for absent, invalid, nonfinite, negative, or reversed-clock input", () => {
    const cases = [
      { prediction: null, activeSeconds: 0, state: "running" as const },
      { prediction: { ...prediction, remainingSeconds: -1 }, activeSeconds: 0, state: "running" as const },
      { prediction: { ...prediction, errorPercent: Number.NaN }, activeSeconds: 0, state: "running" as const },
      { prediction: { ...prediction, errorPercent: 1001 }, activeSeconds: 0, state: "running" as const },
      { prediction: { ...prediction, remainingSeconds: 31_536_001 }, activeSeconds: 0, state: "running" as const },
      { prediction: { ...prediction, observedActiveSeconds: Number.POSITIVE_INFINITY }, activeSeconds: 0, state: "running" as const },
      { prediction, activeSeconds: -1, state: "running" as const },
      { prediction, activeSeconds: 31_536_001, state: "running" as const },
      { prediction, activeSeconds: 99, state: "running" as const }
    ];
    for (const input of cases) {
      expect(projectCountdown(input)).toEqual({ timeText: "Unknown", uncertaintyText: "Unknown", status: "unknown" });
    }
  });

  it("reports a zero center as overdue", () => {
    expect(projectCountdown({
      prediction: { remainingSeconds: 0, errorPercent: 0, observedActiveSeconds: 0 },
      activeSeconds: 0,
      state: "running"
    })).toEqual({ timeText: "00:00:00", uncertaintyText: "±0%", status: "overdue" });
  });
});
