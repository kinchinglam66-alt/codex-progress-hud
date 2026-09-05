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

export const calibrationSummarySchema = z.object({
  phaseClass: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/u),
  outcomeBasis: z.literal("verified_success_only"),
  sampleCount: z.number().int().positive().max(1_000_000),
  averageDurationSeconds: z.number().finite().nonnegative().max(31_536_000),
  averageEstimateErrorSeconds: z.number().finite().nonnegative().max(31_536_000)
}).strict();

export type CalibrationSummary = z.infer<typeof calibrationSummarySchema>;

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
    // Stopping duration is not a successful-completion duration. Validate even excluded input.
    if (sample.outcomeCategory !== "succeeded_verified") continue;
    const bucket = buckets.get(sample.phaseClass) ?? { duration: 0, error: 0, count: 0 };
    bucket.duration += sample.durationSeconds;
    bucket.error += sample.estimateErrorSeconds;
    bucket.count += 1;
    buckets.set(sample.phaseClass, bucket);
  }

  return [...buckets.entries()].map(([phaseClass, bucket]) => ({
    phaseClass,
    outcomeBasis: "verified_success_only",
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
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1) {
    throw new RangeError("minimumSamples must be a positive safe integer");
  }
  const parsed = calibrationSummarySchema.safeParse(
    summaries.find((candidate) => candidate.phaseClass === phaseClass)
  );
  if (!parsed.success || parsed.data.sampleCount < minimumSamples) return undefined;
  const summary = parsed.data;
  return {
    lowSeconds: Math.max(0, summary.averageDurationSeconds - summary.averageEstimateErrorSeconds),
    highSeconds: summary.averageDurationSeconds + summary.averageEstimateErrorSeconds,
    confidence: roundConfidence(Math.min(0.9, 0.3 + summary.sampleCount * 0.1))
  };
}
