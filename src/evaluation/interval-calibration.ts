import { z } from "zod";

const MAX_SECONDS = 31_536_000;
const MIN_TASKS = 30;
const BOOTSTRAP_RESAMPLES = 1_000;
const BUCKETS = [0, 1, 2, 3] as const;
export type CalibrationBucket = (typeof BUCKETS)[number];

const seconds = z.number().finite().nonnegative().max(MAX_SECONDS);
const taskKey = z.string().regex(/^sample_[a-zA-Z0-9_-]{1,64}$/);
const version = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const predictor = z.enum(["raw", "pace"]);
const pointSchema = z.object({
  taskKey,
  predictor,
  version,
  snapshotIndex: z.number().int().nonnegative().safe(),
  predictedSeconds: seconds,
  actualSeconds: seconds,
  verified: z.boolean()
}).strict();
const attemptSchema = z.object({
  taskKey,
  predictor,
  version,
  snapshotIndex: z.number().int().nonnegative().safe(),
  predictedSeconds: seconds.nullable(),
  actualSeconds: seconds.nullable(),
  verified: z.boolean()
}).strict();

export interface CalibrationPoint {
  taskKey: string;
  predictor: "raw" | "pace";
  version: string;
  snapshotIndex: number;
  predictedSeconds: number;
  actualSeconds: number;
  verified: boolean;
}

/** A held-out attempt retains abstentions and labels so availability is not
 * confused with accuracy among answered prefixes. */
export interface CalibrationAttempt {
  taskKey: string;
  predictor: "raw" | "pace";
  version: string;
  snapshotIndex: number;
  predictedSeconds: number | null;
  actualSeconds: number | null;
  verified: boolean;
}

export interface IntervalCandidate {
  bucket: CalibrationBucket;
  predictor: "raw" | "pace";
  version: string;
  halfWidthSeconds: number;
  taskCount: number;
}

export interface CalibrationMetrics {
  attempts: number;
  answered: number;
  abstentions: number;
  excluded: number;
  meanAbsoluteErrorSeconds: number | null;
  p50AbsoluteErrorSeconds: number | null;
  p90AbsoluteErrorSeconds: number | null;
  coverage: number | null;
  meanWidthSeconds: number | null;
  availability: number | null;
  horizonUnknown: number;
}

export interface MetricBand {
  low: number;
  high: number;
  resamples: number;
}

export interface CalibrationBootstrap {
  meanAbsoluteErrorSeconds: MetricBand | null;
  p50AbsoluteErrorSeconds: MetricBand | null;
  p90AbsoluteErrorSeconds: MetricBand | null;
  coverage: MetricBand | null;
  meanWidthSeconds: MetricBand | null;
  availability: MetricBand | null;
}

export interface CalibrationReport {
  all: CalibrationMetrics;
  matched: CalibrationMetrics;
  byHorizon: Record<CalibrationBucket, CalibrationMetrics>;
  bootstrap: CalibrationBootstrap | null;
}

export interface CalibrationComparison {
  candidates: IntervalCandidate[];
  predictors: {
    raw: Record<string, CalibrationReport>;
    pace: Record<string, CalibrationReport>;
  };
  matchedPrefixCount: number;
  snapshotIndices: readonly number[];
}

export interface CalibrationComparisonOptions {
  snapshotIndices: readonly number[];
  seed?: number;
}

type ParsedPoint = z.infer<typeof pointSchema>;
type ParsedAttempt = z.infer<typeof attemptSchema>;
type ScoredSample = {
  taskKey: string;
  error: number;
  width: number | null;
  covered: boolean | null;
};

function bucketFor(secondsValue: number): CalibrationBucket {
  if (secondsValue <= 1_800) return 0;
  if (secondsValue <= 7_200) return 1;
  if (secondsValue <= 28_800) return 2;
  return 3;
}

function identity(value: Pick<CalibrationPoint, "taskKey" | "predictor" | "version" | "snapshotIndex">): string {
  return `${value.taskKey}\u0000${value.predictor}\u0000${value.version}\u0000${value.snapshotIndex}`;
}

function parsePoints(points: readonly CalibrationPoint[]): ParsedPoint[] {
  const identities = new Set<string>();
  return points.map(value => {
    const parsed = pointSchema.parse(value);
    const key = identity(parsed);
    if (identities.has(key)) throw new Error("Duplicate calibration point identity");
    identities.add(key);
    return parsed;
  });
}

function parseAttempts(attempts: readonly CalibrationAttempt[]): ParsedAttempt[] {
  const identities = new Set<string>();
  return attempts.map(value => {
    const parsed = attemptSchema.parse(value);
    const key = identity(parsed);
    if (identities.has(key)) throw new Error("Duplicate calibration attempt identity");
    identities.add(key);
    return parsed;
  });
}

function taskMacroAvailabilityFromParsed(attempts: readonly ParsedAttempt[]): number | null {
  const byTask = new Map<string, { answered: number; total: number }>();
  for (const attempt of attempts) {
    const counts = byTask.get(attempt.taskKey);
    if (counts) {
      counts.total++;
      if (attempt.predictedSeconds !== null) counts.answered++;
    } else {
      byTask.set(attempt.taskKey, {
        answered: attempt.predictedSeconds === null ? 0 : 1,
        total: 1
      });
    }
  }
  return mean([...byTask.values()].map(counts => counts.answered / counts.total));
}

/** Task-macro availability, exposed for offline reports with nonuniform samples. */
export function taskMacroAvailability(attempts: readonly CalibrationAttempt[]): number | null {
  return taskMacroAvailabilityFromParsed(parseAttempts(attempts));
}

function candidateKey(value: Pick<IntervalCandidate, "bucket" | "predictor" | "version">): string {
  return `${value.bucket}\u0000${value.predictor}\u0000${value.version}`;
}

function candidateMap(candidates: readonly IntervalCandidate[]): Map<string, IntervalCandidate> {
  return new Map(candidates.map(candidate => [candidateKey(candidate), candidate]));
}

/** Fit task-balanced absolute residual intervals without changing online ETA. */
export function fitIntervals(points: readonly CalibrationPoint[]): IntervalCandidate[] {
  const parsed = parsePoints(points);
  const groups = new Map<string, {
    bucket: CalibrationBucket;
    predictor: "raw" | "pace";
    version: string;
    tasks: Map<string, ParsedPoint[]>;
  }>();

  for (const point of parsed) {
    if (!point.verified) continue;
    const bucket = bucketFor(point.predictedSeconds);
    const key = candidateKey({ bucket, predictor: point.predictor, version: point.version });
    let group = groups.get(key);
    if (group === undefined) {
      group = { bucket, predictor: point.predictor, version: point.version, tasks: new Map() };
      groups.set(key, group);
    }
    const taskPoints = group.tasks.get(point.taskKey);
    if (taskPoints) taskPoints.push(point);
    else group.tasks.set(point.taskKey, [point]);
  }

  const candidates: IntervalCandidate[] = [];
  for (const group of [...groups.values()].sort((left, right) => {
    return left.bucket - right.bucket || left.predictor.localeCompare(right.predictor) || left.version.localeCompare(right.version);
  })) {
    if (group.tasks.size < MIN_TASKS) continue;
    const residuals: { value: number; weight: number }[] = [];
    for (const taskPoints of group.tasks.values()) {
      const weight = 1 / taskPoints.length;
      for (const point of taskPoints) {
        residuals.push({ value: Math.abs(point.actualSeconds - point.predictedSeconds), weight });
      }
    }
    residuals.sort((left, right) => left.value - right.value);
    let cumulative = 0;
    let halfWidthSeconds = residuals.at(-1)!.value;
    for (const residual of residuals) {
      cumulative += residual.weight;
      if (cumulative + Number.EPSILON >= 0.8 * group.tasks.size) {
        halfWidthSeconds = residual.value;
        break;
      }
    }
    candidates.push({
      bucket: group.bucket,
      predictor: group.predictor,
      version: group.version,
      halfWidthSeconds,
      taskCount: group.tasks.size
    });
  }
  return candidates;
}

export function applyInterval(center: number, candidate: IntervalCandidate): { low: number; high: number } {
  const parsedCenter = seconds.parse(center);
  const parsedCandidate = z.object({
    bucket: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    predictor,
    version,
    halfWidthSeconds: seconds,
    taskCount: z.number().int().positive()
  }).strict().parse(candidate);
  return {
    low: Math.max(0, parsedCenter - parsedCandidate.halfWidthSeconds),
    high: Math.min(MAX_SECONDS, parsedCenter + parsedCandidate.halfWidthSeconds)
  };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weightedNearestRank(values: readonly { value: number; weight: number }[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left.value - right.value);
  const target = sorted.reduce((sum, item) => sum + item.weight, 0) * fraction;
  let total = 0;
  for (const item of sorted) {
    total += item.weight;
    if (total + Number.EPSILON >= target) return item.value;
  }
  return sorted.at(-1)!.value;
}

function metricsFor(
  attempts: readonly ParsedAttempt[],
  candidates: Map<string, IntervalCandidate>
): CalibrationMetrics {
  const labelEligible = attempts.filter(attempt => attempt.verified && attempt.actualSeconds !== null);
  const answered = attempts.filter(attempt => attempt.predictedSeconds !== null);
  const scored = labelEligible.filter(attempt => attempt.predictedSeconds !== null);
  const abstentions = attempts.length - answered.length;
  const excluded = attempts.length - labelEligible.length;
  const candidateSamples = new Map<string, ScoredSample[]>();

  for (const attempt of scored) {
    const candidate = candidates.get(candidateKey({
      bucket: bucketFor(attempt.predictedSeconds!),
      predictor: attempt.predictor,
      version: attempt.version
    }));
    const low = candidate === undefined ? null : Math.max(0, attempt.predictedSeconds! - candidate.halfWidthSeconds);
    const high = candidate === undefined ? null : Math.min(MAX_SECONDS, attempt.predictedSeconds! + candidate.halfWidthSeconds);
    const sample: ScoredSample = {
      taskKey: attempt.taskKey,
      error: Math.abs(attempt.predictedSeconds! - attempt.actualSeconds!),
      width: low === null || high === null ? null : high - low,
      covered: low === null || high === null ? null : low <= attempt.actualSeconds! && attempt.actualSeconds! <= high
    };
    const taskSamples = candidateSamples.get(attempt.taskKey);
    if (taskSamples) taskSamples.push(sample);
    else candidateSamples.set(attempt.taskKey, [sample]);
  }

  const taskMeans: number[] = [];
  const weightedErrors: { value: number; weight: number }[] = [];
  const weightedCoverage: number[] = [];
  const weightedWidths: number[] = [];
  for (const samples of candidateSamples.values()) {
    taskMeans.push(mean(samples.map(sample => sample.error))!);
    const weight = 1 / samples.length;
    for (const sample of samples) weightedErrors.push({ value: sample.error, weight });
    const covered = samples.filter(sample => sample.covered !== null);
    if (covered.length > 0) {
      weightedCoverage.push(covered.reduce((sum, sample) => sum + Number(sample.covered), 0) / covered.length);
      weightedWidths.push(covered.reduce((sum, sample) => sum + sample.width!, 0) / covered.length);
    }
  }
  return {
    attempts: attempts.length,
    answered: answered.length,
    abstentions,
    excluded,
    meanAbsoluteErrorSeconds: mean(taskMeans),
    p50AbsoluteErrorSeconds: weightedNearestRank(weightedErrors, 0.5),
    p90AbsoluteErrorSeconds: weightedNearestRank(weightedErrors, 0.9),
    coverage: mean(weightedCoverage),
    meanWidthSeconds: mean(weightedWidths),
    availability: taskMacroAvailabilityFromParsed(attempts),
    horizonUnknown: abstentions
  };
}

function requireConsistentLabels(attempts: readonly ParsedAttempt[]): void {
  const labels = new Map<string, { verified: boolean; actualSeconds: number | null }>();
  for (const attempt of attempts) {
    const key = `${attempt.taskKey}\u0000${attempt.snapshotIndex}`;
    const prior = labels.get(key);
    if (prior !== undefined && (prior.verified !== attempt.verified || prior.actualSeconds !== attempt.actualSeconds)) {
      throw new Error("Inconsistent labels for task/prefix");
    }
    labels.set(key, {verified: attempt.verified, actualSeconds: attempt.actualSeconds});
  }
}

function validateManifest(manifest: readonly number[]): number[] {
  if (manifest.length === 0) throw new Error("Snapshot manifest must not be empty");
  const parsed = manifest.map(value => z.number().int().nonnegative().safe().parse(value));
  if (new Set(parsed).size !== parsed.length) throw new Error("Snapshot manifest contains duplicates");
  return [...parsed];
}

function requireManifest(points: readonly { snapshotIndex: number }[], manifest: ReadonlySet<number>): void {
  if (points.some(point => !manifest.has(point.snapshotIndex))) {
    throw new Error("Point is outside the fixed snapshot manifest");
  }
}

function requireSingleVersions(attempts: readonly ParsedAttempt[]): void {
  for (const kind of ["raw", "pace"] as const) {
    const versions = new Set(attempts
      .filter(attempt => attempt.predictor === kind)
      .map(attempt => attempt.version));
    if (versions.size > 1) throw new Error("Comparison requires one version per predictor");
  }
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function requireCompleteMatrix(
  attempts: readonly ParsedAttempt[],
  manifest: readonly number[],
  label: string
): void {
  const expected = new Set(manifest);
  const groups = new Map<string, Set<number>>();
  const tasksByPredictor: Record<"raw" | "pace", Set<string>> = { raw: new Set(), pace: new Set() };
  for (const attempt of attempts) {
    const groupKey = `${attempt.predictor}\u0000${attempt.taskKey}`;
    const indexes = groups.get(groupKey);
    if (indexes) indexes.add(attempt.snapshotIndex);
    else groups.set(groupKey, new Set([attempt.snapshotIndex]));
    tasksByPredictor[attempt.predictor].add(attempt.taskKey);
  }
  for (const [groupKey, indexes] of groups) {
    if (indexes.size !== expected.size || [...expected].some(index => !indexes.has(index))) {
      throw new Error(`${label} must provide a complete snapshot schedule for ${groupKey}`);
    }
  }
  if (tasksByPredictor.raw.size > 0 && tasksByPredictor.pace.size > 0 &&
    !sameSet(tasksByPredictor.raw, tasksByPredictor.pace)) {
    throw new Error(`${label} raw and pace predictors must use the same task universe`);
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function band(values: readonly number[]): MetricBand | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    low: sorted[Math.max(0, Math.ceil(sorted.length * 0.025) - 1)]!,
    high: sorted[Math.max(0, Math.ceil(sorted.length * 0.975) - 1)]!,
    resamples: sorted.length
  };
}

function bootstrap(
  attempts: readonly ParsedAttempt[],
  candidates: Map<string, IntervalCandidate>,
  seed: number
): CalibrationBootstrap | null {
  const tasks = new Map<string, ParsedAttempt[]>();
  for (const attempt of attempts) {
    const task = tasks.get(attempt.taskKey);
    if (task) task.push(attempt);
    else tasks.set(attempt.taskKey, [attempt]);
  }
  if (tasks.size < MIN_TASKS) return null;
  const groups = [...tasks.values()];
  const random = mulberry32(seed);
  const collected: Record<keyof CalibrationBootstrap, number[]> = {
    meanAbsoluteErrorSeconds: [], p50AbsoluteErrorSeconds: [], p90AbsoluteErrorSeconds: [],
    coverage: [], meanWidthSeconds: [], availability: []
  };
  for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample++) {
    const sampled: ParsedAttempt[] = [];
    for (let index = 0; index < groups.length; index++) {
      const selected = groups[Math.floor(random() * groups.length)]!;
      const clusterKey = `\u0000bootstrap_${resample}_${index}`;
      sampled.push(...selected.map(attempt => ({ ...attempt, taskKey: `${attempt.taskKey}${clusterKey}` })));
    }
    const metrics = metricsFor(sampled, candidates);
    for (const key of Object.keys(collected) as (keyof CalibrationBootstrap)[]) {
      const value = metrics[key];
      if (typeof value === "number") collected[key].push(value);
    }
  }
  return {
    meanAbsoluteErrorSeconds: band(collected.meanAbsoluteErrorSeconds),
    p50AbsoluteErrorSeconds: band(collected.p50AbsoluteErrorSeconds),
    p90AbsoluteErrorSeconds: band(collected.p90AbsoluteErrorSeconds),
    coverage: band(collected.coverage),
    meanWidthSeconds: band(collected.meanWidthSeconds),
    availability: band(collected.availability)
  };
}

function makeReport(
  attempts: readonly ParsedAttempt[],
  matchedKeys: ReadonlySet<string>,
  candidates: Map<string, IntervalCandidate>,
  seed: number
): CalibrationReport {
  const byHorizon = {} as Record<CalibrationBucket, CalibrationMetrics>;
  for (const bucket of BUCKETS) {
    byHorizon[bucket] = metricsFor(attempts.filter(attempt => attempt.predictedSeconds !== null && bucketFor(attempt.predictedSeconds) === bucket), candidates);
  }
  return {
    all: metricsFor(attempts, candidates),
    matched: metricsFor(attempts.filter(attempt => matchedKeys.has(`${attempt.taskKey}\u0000${attempt.snapshotIndex}`)), candidates),
    byHorizon,
    bootstrap: bootstrap(attempts, candidates, seed)
  };
}

/**
 * Compare fixed, task-disjoint calibration splits. The held-out labels are
 * consumed only for reporting; they are never passed to fitIntervals().
 */
export function compareCalibration(
  training: readonly CalibrationAttempt[],
  heldOut: readonly CalibrationAttempt[],
  options: CalibrationComparisonOptions
): CalibrationComparison {
  const manifest = validateManifest(options.snapshotIndices);
  const trainingAttempts = parseAttempts(training);
  const heldOutAttempts = parseAttempts(heldOut);
  requireManifest(trainingAttempts, new Set(manifest));
  requireManifest(heldOutAttempts, new Set(manifest));
  requireSingleVersions([...trainingAttempts, ...heldOutAttempts]);
  requireCompleteMatrix(trainingAttempts, manifest, "Training");
  requireCompleteMatrix(heldOutAttempts, manifest, "Held-out");
  requireConsistentLabels(trainingAttempts);
  requireConsistentLabels(heldOutAttempts);
  const trainingTasks = new Set(trainingAttempts.map(point => point.taskKey));
  if (heldOutAttempts.some(attempt => trainingTasks.has(attempt.taskKey))) {
    throw new Error("Training and held-out tasks overlap");
  }
  const trainingPoints: CalibrationPoint[] = trainingAttempts.flatMap(attempt => {
    if (attempt.predictedSeconds === null || attempt.actualSeconds === null) return [];
    return [{
      taskKey: attempt.taskKey,
      predictor: attempt.predictor,
      version: attempt.version,
      snapshotIndex: attempt.snapshotIndex,
      predictedSeconds: attempt.predictedSeconds,
      actualSeconds: attempt.actualSeconds,
      verified: attempt.verified
    }];
  });
  const candidates = fitIntervals(trainingPoints);
  const candidateLookup = candidateMap(candidates);
  const answeredKeysByPair = new Map<string, Set<string>>();
  for (const attempt of heldOutAttempts) {
    if (!attempt.verified || attempt.actualSeconds === null || attempt.predictedSeconds === null) continue;
    const pairKey = `${attempt.taskKey}\u0000${attempt.snapshotIndex}`;
    const existing = answeredKeysByPair.get(pairKey);
    if (existing) existing.add(attempt.predictor);
    else answeredKeysByPair.set(pairKey, new Set([attempt.predictor]));
  }
  const matchedKeys = new Set([...answeredKeysByPair.entries()]
    .filter(([, predictors]) => predictors.has("raw") && predictors.has("pace"))
    .map(([key]) => key));
  const predictors: CalibrationComparison["predictors"] = { raw: {}, pace: {} };
  for (const kind of ["raw", "pace"] as const) {
    const versions = new Set(heldOutAttempts.filter(attempt => attempt.predictor === kind).map(attempt => attempt.version));
    for (const [versionName, actualVersion] of [...versions].sort().entries()) {
      const attempts = heldOutAttempts.filter(attempt => attempt.predictor === kind && attempt.version === actualVersion);
      predictors[kind][actualVersion] = makeReport(attempts, matchedKeys, candidateLookup,
        (options.seed ?? 0xC0D3) + versionName + (kind === "pace" ? 1 : 0));
    }
  }
  return { candidates, predictors, matchedPrefixCount: matchedKeys.size, snapshotIndices: manifest };
}

/** Descriptive alias for callers that prefer evaluation terminology. */
export const evaluateCalibration = compareCalibration;
