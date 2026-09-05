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
    outcomeCategory: "succeeded_verified"
  }
] as const;

describe("content-free ETA calibration", () => {
  it("aggregates only anonymous phase, duration, error, and outcome categories", () => {
    expect(aggregateCalibration(samples)).toEqual([
      {
        phaseClass: "implementation",
        outcomeBasis: "verified_success_only",
        sampleCount: 3,
        averageDurationSeconds: 120,
        averageEstimateErrorSeconds: 20
      }
    ]);
  });

  it.each(["failed", "interrupted", "completed_unverified"] as const)(
    "does not let %s observations shift successful durations or meet the minimum", outcomeCategory => {
      const incomplete = { ...samples[0], durationSeconds: 1, estimateErrorSeconds: 0, outcomeCategory };
      const mixed = aggregateCalibration([samples[0], samples[1], incomplete]);
      expect(mixed).toEqual([{
        phaseClass: "implementation", outcomeBasis: "verified_success_only",
        sampleCount: 2, averageDurationSeconds: 110, averageEstimateErrorSeconds: 15
      }]);
      expect(lookupCalibration(mixed, "implementation")).toBeUndefined();
      expect(aggregateCalibration([incomplete])).toEqual([]);
    }
  );

  it("still rejects sensitive fields on excluded samples", () => {
    expect(() => aggregateCalibration([{ ...samples[0], outcomeCategory: "failed", prompt: "private" }])).toThrow();
  });

  it.each([0, -1, 0.5, NaN, Infinity])("rejects invalid minimum sample count %s", minimum => {
    expect(() => lookupCalibration([], "implementation", minimum)).toThrow(RangeError);
  });

  it("declines unproven or malformed summaries instead of producing trusted estimates", () => {
    const good = { phaseClass: "implementation", outcomeBasis: "verified_success_only" as const,
      sampleCount: 3, averageDurationSeconds: 120, averageEstimateErrorSeconds: 20 };
    for (const bad of [
      { ...good, outcomeBasis: undefined },
      { ...good, averageDurationSeconds: NaN },
      { ...good, sampleCount: Infinity },
      { ...good, averageEstimateErrorSeconds: -1 }
    ]) {
      expect(lookupCalibration([bad as typeof good], "implementation")).toBeUndefined();
    }
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
