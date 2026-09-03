import { describe, expect, it } from "vitest";
import {
  aggregateCalibration,
  calibrationSampleSchema,
  lookupCalibration
} from "../../src/core/calibration.js";

const samples = [
  {
    phaseClass: "implementation",
    durationSeconds: 100,
    estimateErrorSeconds: 20,
    outcomeCategory: "succeeded_verified"
  },
  {
    phaseClass: "implementation",
    durationSeconds: 120,
    estimateErrorSeconds: 10,
    outcomeCategory: "succeeded_verified"
  },
  {
    phaseClass: "implementation",
    durationSeconds: 140,
    estimateErrorSeconds: 30,
    outcomeCategory: "completed_unverified"
  }
] as const;

describe("content-free ETA calibration", () => {
  it("aggregates only anonymous phase, duration, error, and outcome categories", () => {
    expect(aggregateCalibration(samples)).toEqual([
      {
        phaseClass: "implementation",
        sampleCount: 3,
        averageDurationSeconds: 120,
        averageEstimateErrorSeconds: 20
      }
    ]);
  });

  it("rejects titles, paths, prompts, and arbitrary extra fields", () => {
    for (const field of ["title", "path", "prompt", "repository", "source", "output"]) {
      expect(
        calibrationSampleSchema.safeParse({ ...samples[0], [field]: "must not be stored" }).success
      ).toBe(false);
    }
  });

  it("omits a calibration lookup until the minimum sample count exists", () => {
    const summary = aggregateCalibration(samples);

    expect(lookupCalibration(summary, "testing")).toBeUndefined();
    expect(lookupCalibration(summary, "implementation")).toEqual({
      lowSeconds: 100,
      highSeconds: 140,
      confidence: 0.6
    });
  });
});
