import { describe, expect, it } from "vitest";
import {
  applyInterval,
  compareCalibration,
  fitIntervals,
  taskMacroAvailability,
  type CalibrationAttempt,
  type CalibrationPoint
} from "../../src/evaluation/interval-calibration.js";

function point(index: number, overrides: Partial<CalibrationPoint> = {}): CalibrationPoint {
  return {
    taskKey: `sample_${index}`,
    predictor: "raw",
    version: "v1",
    snapshotIndex: 0,
    predictedSeconds: 100,
    actualSeconds: 110,
    verified: true,
    ...overrides
  };
}

function attempt(index: number, overrides: Partial<CalibrationAttempt> = {}): CalibrationAttempt {
  return {
    ...point(index),
    ...overrides
  };
}

function scheduledTraining(): CalibrationAttempt[] {
  return Array.from({ length: 30 }, (_, index) => [
    attempt(index, { snapshotIndex: 0 }),
    attempt(index, { snapshotIndex: 1, predictedSeconds: null, actualSeconds: 110 })
  ]).flat();
}

it('rejects inconsistent paired training labels before fitting',()=>{
  for(const changed of [{actualSeconds:120},{verified:false}]){
    const training=Array.from({length:30},(_,index)=>[
      attempt(index),attempt(index,{predictor:'pace',...changed})
    ]).flat();
    expect(()=>compareCalibration(training,[],{snapshotIndices:[0]})).toThrow(/Inconsistent labels/);
  }
});

describe("offline interval calibration", () => {
  it("requires 30 distinct verified tasks and fits their 80% weighted residual", () => {
    const points = Array.from({ length: 30 }, (_, index) => point(index));

    expect(fitIntervals(points).map(candidate => candidate.halfWidthSeconds)).toEqual([10]);
    expect(fitIntervals(points.slice(0, 29))).toEqual([]);
    expect(fitIntervals(Array.from({ length: 30 }, (_, index) => point(0, { snapshotIndex: index })))).toEqual([]);
  });

  it("normalizes repeated snapshots within a task and partitions variants and horizons", () => {
    const points = [
      ...Array.from({ length: 30 }, (_, index) => point(index, {
        snapshotIndex: 0,
        predictedSeconds: 1_800,
        actualSeconds: 1_810
      })),
      ...Array.from({ length: 30 }, (_, index) => point(index, {
        snapshotIndex: 1,
        predictedSeconds: 7_200,
        actualSeconds: 7_210
      })),
      ...Array.from({ length: 30 }, (_, index) => point(index, {
        predictor: "pace",
        version: "v2",
        predictedSeconds: 28_800,
        actualSeconds: 28_820
      })),
      point(0, { snapshotIndex: 2, actualSeconds: 120 })
    ];

    expect(fitIntervals(points)).toEqual([
      { bucket: 0, predictor: "raw", version: "v1", halfWidthSeconds: 10, taskCount: 30 },
      { bucket: 1, predictor: "raw", version: "v1", halfWidthSeconds: 10, taskCount: 30 },
      { bucket: 2, predictor: "pace", version: "v2", halfWidthSeconds: 20, taskCount: 30 }
    ]);
  });

  it("uses an absolute interval around a near-zero center", () => {
    expect(applyInterval(3, {
      bucket: 0,
      predictor: "raw",
      version: "v1",
      halfWidthSeconds: 10,
      taskCount: 30
    })).toEqual({ low: 0, high: 13 });
  });

  it("rejects unsafe points, duplicate identities, and unverified fit inputs", () => {
    expect(() => fitIntervals([point(0, { taskKey: "private/path" })])).toThrow();
    expect(() => fitIntervals([point(0, { version: "../../secret" })])).toThrow();
    expect(() => fitIntervals([point(0), point(0)])).toThrow();
    expect(() => fitIntervals([point(0, { predictedSeconds: -1 })])).toThrow();
    expect(() => fitIntervals([point(0, { snapshotIndex: 1.5 })])).toThrow();
    expect(fitIntervals(Array.from({ length: 30 }, (_, index) => point(index, { verified: false })))).toEqual([]);
  });

  it("requires disjoint tasks and a fixed snapshot manifest for held-out comparisons", () => {
    const training = Array.from({ length: 30 }, (_, index) => point(index));
    const heldOut = [
      attempt(30, { snapshotIndex: 0 }),
      attempt(30, { predictor: "pace", snapshotIndex: 0, predictedSeconds: null, actualSeconds: 110 }),
      attempt(31, { snapshotIndex: 1 })
    ];

    expect(() => compareCalibration(training, heldOut, { snapshotIndices: [0] })).toThrow(/manifest/i);
    expect(() => compareCalibration(training, [attempt(0)], { snapshotIndices: [0] })).toThrow(/overlap/i);
    const result = compareCalibration(training, heldOut.slice(0, 2), { snapshotIndices: [0], seed: 7 });
    expect(result.predictors.raw.v1!.all.availability).toBe(1);
    expect(result.predictors.pace.v1!.all.availability).toBe(0);
    expect(result.predictors.raw.v1!.matched.attempts).toBe(0);
  });

  it("counts answered attempts independently from label eligibility and reports unknown horizons", () => {
    const training = Array.from({ length: 30 }, (_, index) => point(index));
    const result = compareCalibration(training, [
      attempt(30, { predictedSeconds: 100, actualSeconds: null, verified: false }),
      attempt(31, { predictedSeconds: null, actualSeconds: null, verified: false }),
      attempt(32, { predictedSeconds: 100, actualSeconds: 110, verified: true })
    ], { snapshotIndices: [0] });

    expect(result.predictors.raw.v1!.all).toMatchObject({
      attempts: 3,
      answered: 2,
      abstentions: 1,
      excluded: 2,
      availability: 2 / 3,
      meanAbsoluteErrorSeconds: 10,
      horizonUnknown: 1
    });
  });

  it("uses a literal task-macro availability mean for imbalanced task snapshots", () => {
    expect(taskMacroAvailability([
      attempt(0, { snapshotIndex: 0 }),
      attempt(0, { snapshotIndex: 1, predictedSeconds: null }),
      attempt(1, { snapshotIndex: 0 })
    ])).toBe(0.75);
  });

  it("requires every task and predictor to provide the complete scheduled matrix", () => {
    const incompleteTraining = Array.from({ length: 30 }, (_, index) => point(index));
    expect(() => compareCalibration(incompleteTraining, [attempt(30)], { snapshotIndices: [0, 1] }))
      .toThrow(/complete.*schedule/i);

    const training = scheduledTraining();
    expect(() => compareCalibration(training, [attempt(30)], { snapshotIndices: [0, 1] }))
      .toThrow(/complete.*schedule/i);

    const result = compareCalibration(training, [
      attempt(30, { snapshotIndex: 0 }),
      attempt(30, { snapshotIndex: 1, predictedSeconds: null, actualSeconds: 110 })
    ], { snapshotIndices: [0, 1] });
    expect(result.predictors.raw.v1!.all).toMatchObject({ attempts: 2, answered: 1, abstentions: 1, availability: 0.5 });
  });

  it("rejects multi-version predictors and inconsistent paired labels", () => {
    const training = Array.from({ length: 30 }, (_, index) => point(index));
    expect(() => compareCalibration(training, [
      attempt(30, { version: "v1" }),
      attempt(31, { version: "v2" })
    ], { snapshotIndices: [0] })).toThrow(/one version/i);

    expect(() => compareCalibration(training, [
      attempt(30, { predictor: "raw", actualSeconds: 110 }),
      attempt(30, { predictor: "pace", actualSeconds: 111 })
    ], { snapshotIndices: [0] })).toThrow(/label/i);

    expect(() => compareCalibration(training, [
      attempt(30, { predictor: "raw" }),
      attempt(31, { predictor: "pace" })
    ], { snapshotIndices: [0] })).toThrow(/same task universe/i);
  });

  it("uses clipped interval width at the seconds ceiling", () => {
    const training = Array.from({ length: 30 }, (_, index) => point(index, {
      predictedSeconds: 31_535_990,
      actualSeconds: 31_536_000
    }));
    const result = compareCalibration(training, [attempt(30, {
      predictedSeconds: 31_536_000,
      actualSeconds: 31_536_000
    })], { snapshotIndices: [0] });

    expect(result.predictors.raw.v1!.byHorizon[3]!.meanWidthSeconds).toBe(10);
  });

  it("preserves bootstrap task multiplicity when a task is selected repeatedly", () => {
    const training = Array.from({ length: 30 }, (_, index) => point(index));
    const heldOut = Array.from({ length: 30 }, (_, index) => attempt(index + 30, {
      predictedSeconds: 100,
      actualSeconds: 100 + index,
      snapshotIndex: 0
    }));
    const result = compareCalibration(training, heldOut, { snapshotIndices: [0], seed: 19 });
    const band = result.predictors.raw.v1!.bootstrap!.meanAbsoluteErrorSeconds!;
    expect(band).toEqual({ low: 11.533333333333333, high: 17.7, resamples: 1000 });
  });

  it("reports task-macro horizon metrics and deterministic bootstrap bands", () => {
    const training = Array.from({ length: 30 }, (_, index) => point(index));
    const heldOut = Array.from({ length: 30 }, (_, index) => attempt(index + 30, {
      predictedSeconds: 100,
      actualSeconds: 110,
      snapshotIndex: 0
    }));
    const first = compareCalibration(training, heldOut, { snapshotIndices: [0], seed: 42 });
    const second = compareCalibration(training, heldOut, { snapshotIndices: [0], seed: 42 });

    expect(first.predictors.raw.v1!.all).toMatchObject({
      attempts: 30,
      answered: 30,
      meanAbsoluteErrorSeconds: 10,
      p50AbsoluteErrorSeconds: 10,
      p90AbsoluteErrorSeconds: 10,
      coverage: 1,
      availability: 1
    });
    expect(first.predictors.raw.v1!.byHorizon[0]).toMatchObject({ attempts: 30, answered: 30 });
    expect(first.predictors.raw.v1!.bootstrap).toEqual(second.predictors.raw.v1!.bootstrap);
    expect(first.predictors.raw.v1!.bootstrap?.meanAbsoluteErrorSeconds).toEqual({
      low: 10,
      high: 10,
      resamples: 1000
    });
  });
});
