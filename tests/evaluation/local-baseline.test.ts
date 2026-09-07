import { describe, expect, it } from "vitest";
import * as local from "../../src/evaluation/local-baseline.js";
import { evaluateTraces, type Trace } from "../../src/evaluation/replay.js";

const make = (key: string, total = 100): Trace => ({ sampleKey: `sample_${key}`,
  observations: [{ atSeconds: 0, state: "running", progress: 0 },
    { atSeconds: 50, state: "running", progress: 0.5 }],
  end: { atSeconds: total, outcome: "succeeded_verified" } });
const training = Array.from({ length: 5 }, (_, i) => make(`train${i}`));
const calibration = Array.from({ length: 5 }, (_, i) => make(`cal${i}`, 120));

describe("offline historical quantile baseline", () => {
  it("returns unknown for cold start without historical data", () => {
    const model = local.fitLocalBaseline([], []);
    expect(evaluateTraces([make("cold")], model.raw).metrics).toMatchObject({ unavailable: 2, maeSeconds: null });
  });
  it("fits raw ranges and independently calibrates using task-level maximum error", () => {
    const model = local.fitLocalBaseline(training, calibration);
    expect(evaluateTraces([make("test", 110)], model.raw).rows.map(r => r.prediction))
      .toEqual([{ lowSeconds: 100, highSeconds: 100 }, { lowSeconds: 50, highSeconds: 50 }]);
    expect(evaluateTraces([make("test", 110)], model.calibrated).rows.map(r => r.prediction))
      .toEqual([{ lowSeconds: 80, highSeconds: 120 }, { lowSeconds: 30, highSeconds: 70 }]);
    expect(model.diagnostics).toMatchObject({ calibrationTasks: 5, correctionSeconds: 20 });
  });
  it("counts distinct tasks rather than many observations as training support", () => {
    const dense = make("dense");
    dense.observations = Array.from({ length: 50 }, (_, i) => ({ atSeconds: i, state: "running", progress: 0.1 }));
    const model = local.fitLocalBaseline([dense], []);
    expect(evaluateTraces([make("test")], model.raw).metrics.unavailable).toBe(2);
  });
  it("does not learn from interrupted or unverified endings", () => {
    for (const outcome of ["interrupted", "failed", "unfinished", "completed_unverified"] as const) {
      const model = local.fitLocalBaseline(training.map(t => ({ ...t, end: { ...t.end, outcome } })), calibration);
      expect(evaluateTraces([make("test")], model.raw).metrics.unavailable).toBe(2);
      expect(model.diagnostics.correctionSeconds).toBeNull();
    }
  });
  it("abstains from calibration with too few independent tasks", () => {
    const model = local.fitLocalBaseline(training, calibration.slice(0, 3));
    expect(model.diagnostics.correctionSeconds).toBeNull();
    expect(evaluateTraces([make("test")], model.calibrated).metrics.unavailable).toBe(2);
  });
  it("ignores model estimates and does not infer completion from progress one", () => {
    const model = local.fitLocalBaseline(training, calibration);
    const predict = model.raw();
    expect(predict([{ atSeconds: 50, activeSeconds: 50, state: "running", progress: 0.5,
      modelEstimateSeconds: 9999, modelConfidence: 1 }])).toEqual({ lowSeconds: 50, highSeconds: 50 });
    expect(predict([{ atSeconds: 50, activeSeconds: 50, state: "running", progress: 1 }])).toBeNull();
    expect(predict([{ atSeconds: 50, activeSeconds: 50, state: "waiting", progress: 0.5 }])).toBeNull();
  });
  it("rejects overlap between all three data splits before evaluation", () => {
    expect(() => local.fitLocalBaseline(training, training)).toThrow(/overlap/);
    expect(() => local.compareLocalBaselines(training, calibration, training)).toThrow(/overlap/);
    expect(() => local.compareLocalBaselines(training, calibration, calibration)).toThrow(/overlap/);
  });
  it("compares three methods on the same test prefixes without future-label leakage", () => {
    const a = local.compareLocalBaselines(training, calibration, [make("test", 110)]);
    const b = local.compareLocalBaselines(training, calibration, [make("test", 200)]);
    expect(a.names).toEqual(["existing-local", "historical-quantiles", "calibrated-historical"]);
    expect(a.comparison.predictors[1]!.all.metrics).toMatchObject({ scored: 2, maeSeconds: 10, coverage: 0 });
    expect(a.comparison.predictors[2]!.all.metrics).toMatchObject({ scored: 2, maeSeconds: 10, coverage: 1, meanWidthSeconds: 40 });
    expect(a.comparison.predictors.map(p => p.all.rows.map(r => r.prediction)))
      .toEqual(b.comparison.predictors.map(p => p.all.rows.map(r => r.prediction)));
  });
  it("excludes waits when deriving historical labels", () => {
    const waited = training.map(t => ({ ...t, observations: [t.observations[0]!,
      { atSeconds: 10, state: "waiting" as const }, { atSeconds: 100, state: "running" as const, progress: 0.5 }],
      end: { atSeconds: 110, outcome: "succeeded_verified" as const } }));
    const model = local.fitLocalBaseline(waited, []);
    expect(evaluateTraces([make("test")], model.raw).rows.map(r => r.prediction))
      .toEqual([{ lowSeconds: 20, highSeconds: 20 }, { lowSeconds: 10, highSeconds: 10 }]);
  });
  it("uses empirical tail quantiles rather than the mean for varied durations", () => {
    const varied = Array.from({ length: 10 }, (_, i) => make(`varied${i}`, 100 + i * 10));
    const model = local.fitLocalBaseline(varied, []);
    expect(evaluateTraces([make("test")], model.raw).rows.map(r => r.prediction))
      .toEqual([{ lowSeconds: 100, highSeconds: 180 }, { lowSeconds: 50, highSeconds: 130 }]);
  });
  it("retains an outlying task's maximum error without weighting a dense task more", () => {
    const data = calibration.map((t, i) => make(`out${i}`, i === 4 ? 200 : 100));
    data[0]!.observations = Array.from({ length: 50 }, (_, i) => ({ atSeconds: i, state: "running", progress: 0 }));
    const model = local.fitLocalBaseline(training, data);
    expect(model.diagnostics).toMatchObject({ calibrationTasks: 5, correctionSeconds: 100 });
  });
  it("keeps fitted predictions independent of later input or returned-object mutation", () => {
    const data = training.map(t => structuredClone(t));
    const model = local.fitLocalBaseline(data, calibration);
    data[0]!.end.atSeconds = 999;
    const prefix = [{ atSeconds: 0, activeSeconds: 0, state: "running" as const, progress: 0 }];
    const result = model.raw()(prefix)!; result.highSeconds = 999;
    expect(model.raw()(prefix)).toEqual({ lowSeconds: 100, highSeconds: 100 });
  });
});
