import { z } from "zod";
import { estimateRemaining } from "../core/eta.js";
import { createInitialTask } from "../core/reducer.js";

const seconds = z.number().finite().nonnegative().max(31_536_000);
const observationSchema = z.object({
  atSeconds: seconds,
  state: z.enum(["running", "waiting", "paused"]),
  progress: z.number().min(0).max(1).optional(),
  modelEstimateSeconds: seconds.optional(),
  modelConfidence: z.number().min(0).max(1).optional()
}).strict();
const traceSchema = z.object({
  sampleKey: z.string().regex(/^sample_[a-zA-Z0-9_-]{1,64}$/),
  observations: z.array(observationSchema).min(1),
  end: z.object({ atSeconds: seconds, outcome: z.enum([
    "succeeded_verified", "completed_unverified", "failed", "interrupted", "unfinished"
  ]) }).strict()
}).strict();

export type Trace = z.infer<typeof traceSchema>;
export type PrefixPoint = Readonly<z.infer<typeof observationSchema> & { activeSeconds: number }>;
export interface Prediction { lowSeconds: number; highSeconds: number }
export type Predictor = (prefix: readonly PrefixPoint[]) => Prediction | null;
export interface EvaluationRow {
  sampleKey: string;
  observationIndex: number;
  actualSeconds: number | null;
  prediction: Prediction | null;
  result: "predicted" | "unavailable" | "invalid";
}

function parseTraces(input: readonly unknown[]): Trace[] {
  const traces = input.map(value => traceSchema.parse(value));
  const keys = new Set<string>();
  for (const trace of traces) {
    if (keys.has(trace.sampleKey)) throw new Error("Duplicate sample key");
    keys.add(trace.sampleKey);
    if (trace.observations[0]!.atSeconds !== 0) throw new Error("Trace must start at relative time zero");
    let previous = -1;
    for (const point of trace.observations) {
      if (point.atSeconds <= previous) throw new Error("Observation times must increase strictly");
      previous = point.atSeconds;
    }
    if (trace.end.atSeconds < previous) throw new Error("End precedes an observation");
  }
  return traces;
}

/** Dataset producers must keep one stable anonymous key per task across splits. */
export function assertDisjointTasks(training: readonly unknown[], test: readonly unknown[]): void {
  const keys = new Set(parseTraces(training).map(trace => trace.sampleKey));
  if (parseTraces(test).some(trace => keys.has(trace.sampleKey))) {
    throw new Error("Training and evaluation tasks overlap");
  }
}

/** Baseline adapter: points are full observations, not partial field patches. */
export function baselinePredictor(): Predictor {
  return prefix => {
    const point = prefix.at(-1);
    if (point === undefined || point.state !== "running") return null;
    const nowMs = point.atSeconds * 1_000;
    const estimate = estimateRemaining({
      ...createInitialTask("offline", "", 0),
      status: "running",
      activeElapsedMs: point.activeSeconds * 1_000,
      activeSince: undefined,
      progress: point.progress,
      modelEstimateSeconds: point.modelEstimateSeconds,
      modelConfidence: point.modelConfidence
    }, nowMs);
    return estimate === null ? null : {
      lowSeconds: estimate.lowSeconds, highSeconds: estimate.highSeconds
    };
  };
}

const predictionSchema = z.object({ lowSeconds: seconds, highSeconds: seconds })
  .refine(value => value.highSeconds >= value.lowSeconds);
const mean = (values: readonly number[]): number | null => values.length === 0
  ? null : values.reduce((sum, value) => sum + value / values.length, 0);
function percentile(sorted: readonly number[], fraction: number): number | null {
  return sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

function summarize(rows: readonly EvaluationRow[]) {
  const errors: number[] = [], widths: number[] = [], relative: number[] = [], covered: number[] = [];
  for (const row of rows) {
    if (row.actualSeconds === null || row.prediction === null) continue;
    const { lowSeconds, highSeconds } = row.prediction;
    const error = Math.abs((lowSeconds + highSeconds) / 2 - row.actualSeconds);
    errors.push(error);
    widths.push(highSeconds - lowSeconds);
    relative.push(error / Math.max(1, row.actualSeconds));
    covered.push(Number(lowSeconds <= row.actualSeconds && row.actualSeconds <= highSeconds));
  }
  errors.sort((a, b) => a - b);
  return {
    attempts: rows.length,
    scored: errors.length,
    censored: rows.filter(row => row.actualSeconds === null).length,
    unavailable: rows.filter(row => row.result === "unavailable").length,
    invalid: rows.filter(row => row.result === "invalid").length,
    maeSeconds: mean(errors),
    p50ErrorSeconds: percentile(errors, 0.5),
    p90ErrorSeconds: percentile(errors, 0.9),
    coverage: mean(covered),
    meanWidthSeconds: mean(widths),
    meanRelativeError: mean(relative)
  };
}

/** Pure offline evaluation. No IO, runtime subscriptions, persistence or model calls. */
export function evaluateTraces(input: readonly unknown[], factory: () => Predictor) {
  const traces = parseTraces(input);
  const rows: EvaluationRow[] = [];
  for (const trace of traces) {
    const predict = factory();
    const prefix: PrefixPoint[] = [];
    const pending: { row: EvaluationRow; activeSeconds: number }[] = [];
    let activeSeconds = 0;
    for (const [index, point] of trace.observations.entries()) {
      const previous = prefix.at(-1);
      if (previous?.state === "running") activeSeconds += point.atSeconds - previous.atSeconds;
      prefix.push(Object.freeze({ ...point, activeSeconds }));
      if (point.state !== "running") continue;
      let prediction: Prediction | null = null;
      let result: EvaluationRow["result"] = "invalid";
      try {
        const raw = predict(Object.freeze([...prefix]));
        if (raw === null) result = "unavailable";
        else {
          const parsed = predictionSchema.safeParse(raw);
          if (parsed.success) { prediction = parsed.data; result = "predicted"; }
        }
      } catch { /* Predictor failure is measured, never silently removed. */ }
      const row: EvaluationRow = {
        sampleKey: trace.sampleKey, observationIndex: index, actualSeconds: null, prediction, result
      };
      rows.push(row);
      pending.push({ row, activeSeconds });
    }
    // Outcomes enter scoring only after every prediction for this task is made.
    const last = prefix.at(-1)!;
    if (last.state === "running") activeSeconds += trace.end.atSeconds - last.atSeconds;
    if (trace.end.outcome === "succeeded_verified") {
      for (const point of pending) point.row.actualSeconds = activeSeconds - point.activeSeconds;
    }
  }
  return { rows, metrics: summarize(rows) };
}

export function comparePredictors(input: readonly unknown[], factories: readonly (() => Predictor)[]): {
  commonScored: number;
  predictors: { all: ReturnType<typeof evaluateTraces>; matched: ReturnType<typeof summarize> }[];
} {
  if (factories.length < 2) throw new Error("Comparison requires at least two predictors");
  const traces = parseTraces(input);
  const evaluations = factories.map(factory => evaluateTraces(traces, factory));
  const common = evaluations[0]!.rows.map((_row, index) => evaluations.every(evaluation => {
    const row = evaluation.rows[index]!;
    return row.actualSeconds !== null && row.result === "predicted";
  }));
  return {
    commonScored: common.filter(Boolean).length,
    predictors: evaluations.map(all => ({
      all, matched: summarize(all.rows.filter((_row, index) => common[index]))
    }))
  };
}
