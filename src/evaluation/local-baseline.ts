import { assertDisjointTasks, baselinePredictor, comparePredictors, evaluateTraces,
  type PrefixPoint, type Predictor } from "./replay.js";

// Deliberately small, offline reference model. No IO, training on test data,
// model calls, displayed-ETA replacement or claim of calibrated live coverage.
const MIN_TASKS = 5;
const COVERAGE = 0.8;
const MAX_SECONDS = 31_536_000;
function bucket(point: PrefixPoint): number | null {
  if (point.state !== "running") return null;
  if (point.progress === undefined) return 5;
  if (!Number.isFinite(point.progress) || point.progress < 0 || point.progress > 1) return null;
  // 100% is a separate observation category, never evidence of completion.
  return Math.min(4, Math.floor(point.progress * 4));
}
function distance(point: PrefixPoint, bin: number): number {
  return bin < 4 ? Math.abs(point.progress! - (bin + 0.5) / 4) : 0;
}
function quantile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function fitLocalBaseline(training: readonly unknown[], calibration: readonly unknown[]) {
  assertDisjointTasks(training, calibration);
  const observed: PrefixPoint[] = [];
  const labels = evaluateTraces(training, () => prefix => {
    observed.push(prefix.at(-1)!); return null;
  }).rows;
  // Each training task contributes at most one label per progress bucket,
  // chosen nearest its centre; ties retain the earliest observation.
  const chosen = new Map<string, Map<number, { remaining: number; distance: number }>>();
  for (const [i, row] of labels.entries()) {
    if (row.actualSeconds === null) continue;
    const point = observed[i]!; const bin = bucket(point);
    if (bin === null) continue;
    let task = chosen.get(row.sampleKey);
    if (!task) { task = new Map(); chosen.set(row.sampleKey, task); }
    const candidate = { remaining: row.actualSeconds, distance: distance(point, bin) };
    if (!task.has(bin) || candidate.distance < task.get(bin)!.distance) task.set(bin, candidate);
  }
  const bins: number[][] = Array.from({ length: 6 }, () => []);
  for (const task of chosen.values()) for (const [bin, value] of task) bins[bin]!.push(value.remaining);
  for (const values of bins) values.sort((a, b) => a - b);
  const ranges = bins.map(values => values.length < MIN_TASKS ? null : Object.freeze({
    lowSeconds: quantile(values, 0.1), highSeconds: quantile(values, 0.9)
  }));
  const raw = (): Predictor => prefix => {
    const point = prefix.at(-1);
    if (!point) return null;
    const bin = bucket(point);
    const range = bin === null ? null : ranges[bin];
    return range ? { ...range } : null;
  };
  // One nonnegative maximum error per verified calibration task. Unsupported
  // prefixes remain abstentions; diagnostics expose the conditional support.
  const calibrationRows = evaluateTraces(calibration, raw).rows;
  const scores = new Map<string, number>();
  for (const row of calibrationRows) {
    if (row.actualSeconds === null || row.prediction === null) continue;
    const error = Math.max(0, row.prediction.lowSeconds - row.actualSeconds,
      row.actualSeconds - row.prediction.highSeconds);
    scores.set(row.sampleKey, Math.max(scores.get(row.sampleKey) ?? 0, error));
  }
  const sorted = [...scores.values()].sort((a, b) => a - b);
  const rank = Math.ceil((sorted.length + 1) * COVERAGE);
  // Do not silently clamp a non-existent finite-sample quantile to the maximum.
  const correctionSeconds = rank <= sorted.length ? sorted[rank - 1]! : null;
  const calibrated = (): Predictor => {
    const predict = raw();
    return prefix => {
      const range = predict(prefix);
      if (!range || correctionSeconds === null) return null;
      return { lowSeconds: Math.max(0, range.lowSeconds - correctionSeconds),
        highSeconds: Math.min(MAX_SECONDS, range.highSeconds + correctionSeconds) };
    };
  };
  return Object.freeze({ raw, calibrated, diagnostics: Object.freeze({
    targetCoverage: COVERAGE, minimumTrainingTasksPerBucket: MIN_TASKS,
    trainingTasks: chosen.size, supportByBucket: Object.freeze(bins.map(values => values.length)),
    calibrationTasks: scores.size, calibrationAttempts: calibrationRows.length,
    calibrationUnavailable: calibrationRows.filter(row => row.result === "unavailable").length,
    calibrationCensored: calibrationRows.filter(row => row.actualSeconds === null).length,
    correctionSeconds
  }) });
}

/** Safe evaluation entry: anonymous keys must remain stable across data splits.
 * Source collection must also prevent related tasks/repositories crossing splits.
 */
export function compareLocalBaselines(training: readonly unknown[], calibration: readonly unknown[], test: readonly unknown[]) {
  assertDisjointTasks(training, test); assertDisjointTasks(calibration, test);
  const model = fitLocalBaseline(training, calibration);
  const existingLocal = (): Predictor => {
    const predict = baselinePredictor();
    return prefix => predict(prefix.map(({ modelEstimateSeconds: _eta, modelConfidence: _confidence, ...point }) => point));
  };
  return { names: ["existing-local", "historical-quantiles", "calibrated-historical"] as const,
    diagnostics: model.diagnostics,
    comparison: comparePredictors(test, [existingLocal, model.raw, model.calibrated]) };
}
