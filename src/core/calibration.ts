import { z } from "zod";
import type { CalibrationEstimate } from "./eta.js";

export const calibrationSampleSchema = z
  .object({
    phaseClass: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    durationSeconds: z.number().finite().nonnegative().max(31_536_000),
    estimateErrorSeconds: z.number().finite().nonnegative().max(31_536_000),
    outcomeCategory: z.enum([
      "succeeded_verified",
      "completed_unverified",
      "failed",
      "interrupted"
    ])
  })
  .strict();

export type CalibrationSample = z.infer<typeof calibrationSampleSchema>;

export interface CalibrationSummary {
  phaseClass: string;
  sampleCount: number;
  averageDurationSeconds: number;
  averageEstimateErrorSeconds: number;
}

function roundSecond(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}

export function aggregateCalibration(values: readonly unknown[]): CalibrationSummary[] {
  const buckets = new Map<string, { duration: number; error: number; count: number }>();
  for (const value of values) {
    const sample = calibrationSampleSchema.parse(value);
    const bucket = buckets.get(sample.phaseClass) ?? { duration: 0, error: 0, count: 0 };
    bucket.duration += sample.durationSeconds;
    bucket.error += sample.estimateErrorSeconds;
    bucket.count += 1;
    buckets.set(sample.phaseClass, bucket);
  }

  return [...buckets.entries()].map(([phaseClass, bucket]) => ({
    phaseClass,
    sampleCount: bucket.count,
    averageDurationSeconds: roundSecond(bucket.duration / bucket.count),
    averageEstimateErrorSeconds: roundSecond(bucket.error / bucket.count)
  }));
}

export function lookupCalibration(
  summaries: readonly CalibrationSummary[],
  phaseClass: string,
  minimumSamples = 3
): CalibrationEstimate | undefined {
  const summary = summaries.find((candidate) => candidate.phaseClass === phaseClass);
  if (summary === undefined || summary.sampleCount < minimumSamples) return undefined;
  return {
    lowSeconds: Math.max(0, summary.averageDurationSeconds - summary.averageEstimateErrorSeconds),
    highSeconds: summary.averageDurationSeconds + summary.averageEstimateErrorSeconds,
    confidence: roundConfidence(Math.min(0.9, 0.3 + summary.sampleCount * 0.1))
  };
}
