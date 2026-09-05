import { describe, expect, it } from "vitest";
import { evaluateTraces, comparePredictors, assertDisjointTasks, baselinePredictor, type Trace } from "../../src/evaluation/replay.js";

const trace: Trace = {
  sampleKey: "sample_one",
  observations: [
    { atSeconds: 0, state: "running", progress: 0 },
    { atSeconds: 10, state: "waiting" },
    { atSeconds: 100, state: "running", progress: 0.5 }
  ],
  end: { atSeconds: 110, outcome: "succeeded_verified" }
};

describe("offline ETA replay", () => {
  it("compares errors only on common answered prefixes while retaining missing counts", () => {
    const result = comparePredictors([trace], [
      baselinePredictor,
      () => () => ({ lowSeconds: 18, highSeconds: 22 })
    ]);
    expect(result.commonScored).toBe(1);
    expect(result.predictors.map(item => item.all.metrics.unavailable)).toEqual([1, 0]);
    expect(result.predictors.map(item => item.all.metrics.attempts)).toEqual([2, 2]);
    expect(result.predictors.map(item => item.matched.attempts)).toEqual([1, 1]);
    expect(result.predictors.map(item => item.matched.maeSeconds)).toEqual([0, 10]);
  });

  it("requires at least two predictors for a comparison", () => {
    expect(() => comparePredictors([trace], [])).toThrow();
    expect(() => comparePredictors([trace], [baselinePredictor])).toThrow();
  });

  it("handles a comparison with no common answer without implying zero error", () => {
    const result = comparePredictors([trace], [baselinePredictor, () => () => null]);
    expect(result.commonScored).toBe(0);
    expect(result.predictors).toHaveLength(2);
    expect(result.predictors.every(item => item.matched.maeSeconds === null)).toBe(true);
  });

  it("excludes paused intervals as well as waits", () => {
    const paused = { ...trace, observations: trace.observations.map(point => point.state === "waiting" ? { ...point, state: "paused" as const } : point) };
    expect(evaluateTraces([paused], baselinePredictor).rows.map(row => row.actualSeconds)).toEqual([20, 10]);
  });

  it("rejects unknown metadata and equal-time observations before invoking predictors", () => {
    let called = false;
    const factory = () => { called = true; return () => null; };
    expect(() => evaluateTraces([{ ...trace, prompt: "private" }], factory)).toThrow();
    expect(() => evaluateTraces([{ ...trace, observations: [trace.observations[0], trace.observations[0]] }], factory)).toThrow();
    expect(called).toBe(false);
  });

  it("excludes waits from active remaining time and scores literal errors", () => {
    const result = evaluateTraces([trace], () => () => ({ lowSeconds: 8, highSeconds: 12 }));
    expect(result.rows.map(row => row.actualSeconds)).toEqual([20, 10]);
    expect(result.metrics).toMatchObject({
      attempts: 2, scored: 2, censored: 0, unavailable: 0, invalid: 0,
      maeSeconds: 5, p50ErrorSeconds: 0, p90ErrorSeconds: 10,
      coverage: 0.5, meanWidthSeconds: 4, meanRelativeError: 0.25
    });
  });

  it("passes only frozen prefixes and starts a fresh predictor for each task", () => {
    const lengths: number[] = [];
    const active: number[][] = [];
    let factories = 0;
    const result = evaluateTraces([trace, { ...trace, sampleKey: "sample_two" }], () => {
      factories++;
      return prefix => {
        lengths.push(prefix.length);
        active.push(prefix.map(point => point.activeSeconds));
        expect(Object.isFrozen(prefix)).toBe(true);
        expect(prefix.every(Object.isFrozen)).toBe(true);
        expect(prefix[0]).not.toHaveProperty("end");
        expect(prefix[0]).not.toHaveProperty("sampleKey");
        return null;
      };
    });
    expect(factories).toBe(2);
    expect(lengths).toEqual([1, 3, 1, 3]);
    expect(active).toEqual([[0], [0, 10, 10], [0], [0, 10, 10]]);
    expect(result.metrics).toMatchObject({ attempts: 4, unavailable: 4, scored: 0, maeSeconds: null });
  });

  it.each(["interrupted", "failed", "unfinished", "completed_unverified"] as const)(
    "does not treat %s stopping time as successful completion", outcome => {
      const result = evaluateTraces([{ ...trace, end: { ...trace.end, outcome } }], () => () => ({ lowSeconds: 1, highSeconds: 2 }));
      expect(result.rows.every(row => row.actualSeconds === null)).toBe(true);
      expect(result.metrics).toMatchObject({ attempts: 2, censored: 2, scored: 0, coverage: null });
    }
  );

  it("rejects future labels in observations and non-monotonic timelines", () => {
    expect(() => evaluateTraces([{ ...trace, observations: [{ ...trace.observations[0], end: trace.end }] }], baselinePredictor)).toThrow();
    expect(() => evaluateTraces([{ ...trace, observations: [...trace.observations].reverse() }], baselinePredictor)).toThrow();
    expect(() => evaluateTraces([{ ...trace, end: { ...trace.end, atSeconds: 99 } }], baselinePredictor)).toThrow();
  });

  it.each([NaN, Infinity, -1])("rejects invalid clock %s", atSeconds => {
    expect(() => evaluateTraces([{ ...trace, end: { ...trace.end, atSeconds } }], baselinePredictor)).toThrow();
  });

  it("rejects duplicate samples and train/test overlap", () => {
    expect(() => evaluateTraces([trace, trace], baselinePredictor)).toThrow();
    expect(() => assertDisjointTasks([trace], [trace])).toThrow();
    expect(() => assertDisjointTasks([trace], [{ ...trace, sampleKey: "sample_two" }])).not.toThrow();
  });

  it.each([
    { lowSeconds: NaN, highSeconds: 10 },
    { lowSeconds: 10, highSeconds: 9 },
    { lowSeconds: -1, highSeconds: 1 },
    { lowSeconds: 1, highSeconds: Infinity }
  ])("counts invalid output without silently dropping attempts: %j", prediction => {
    expect(evaluateTraces([trace], () => () => prediction).metrics).toMatchObject({ attempts: 2, invalid: 2, scored: 0 });
  });

  it("counts predictor exceptions as invalid and continues the next prefix", () => {
    let count = 0;
    expect(evaluateTraces([trace], () => () => {
      if (count++ === 0) throw new Error("predictor failed");
      return { lowSeconds: 10, highSeconds: 10 };
    }).metrics).toMatchObject({ attempts: 2, invalid: 1, scored: 1, maeSeconds: 0 });
  });

  it("replays the existing estimator without changing online behavior", () => {
    const result = evaluateTraces([trace], baselinePredictor);
    expect(result.rows.map(row => row.prediction)).toEqual([null, { lowSeconds: 5, highSeconds: 15 }]);
    expect(result.metrics).toMatchObject({ unavailable: 1, scored: 1, maeSeconds: 0, coverage: 1 });
  });

  it("never supplies changed future outcomes to an earlier prediction", () => {
    const changed = { ...trace, end: { atSeconds: 999, outcome: "interrupted" as const } };
    const a = evaluateTraces([trace], baselinePredictor);
    const b = evaluateTraces([changed], baselinePredictor);
    expect(a.rows).toHaveLength(2);
    expect(a.rows.map(row => row.prediction)).toEqual(b.rows.map(row => row.prediction));
  });

  it("uses a one-second relative-error floor and returns null metrics for empty input", () => {
    const zero = { ...trace, observations: [{ atSeconds: 0, state: "running" as const }], end: { atSeconds: 0, outcome: "succeeded_verified" as const } };
    expect(evaluateTraces([zero], () => () => ({ lowSeconds: 2, highSeconds: 2 })).metrics.meanRelativeError).toBe(2);
    expect(evaluateTraces([], baselinePredictor).metrics).toMatchObject({ attempts: 0, maeSeconds: null, coverage: null });
  });
});
