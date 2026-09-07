import { z } from "zod";
import { predictionSchema } from "../estimation/contracts.js";
import { assertDisjointTasks, baselinePredictor, comparePredictors, evaluateTraces, type PrefixPoint } from "./replay.js";

const independentPointSchema = z.object({
  atSeconds: z.number().finite().nonnegative(), activeSeconds: z.number().finite().nonnegative(),
  state: z.enum(["running", "waiting", "paused"]), progress: z.number().min(0).max(1).optional()
}).strict();
export type IndependentPoint = Readonly<z.infer<typeof independentPointSchema>>;
export type AsyncPredictor = (prefix: readonly IndependentPoint[], signal: AbortSignal) => Promise<unknown>;
function independentPrefix(prefix: readonly PrefixPoint[]): readonly IndependentPoint[] {
  return Object.freeze(prefix.map(point => Object.freeze(independentPointSchema.parse({
    atSeconds: point.atSeconds, activeSeconds: point.activeSeconds, state: point.state,
    ...(point.progress === undefined ? {} : { progress: point.progress })
  }))));
}
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resultSchema = z.object({ prediction: predictionSchema.nullable(), costMicrousd: amount.optional() }).strict();
interface Options {
  training: readonly unknown[];
  reservationMicrousd: number;
  timeoutMs?: number;
  now?: () => number;
}

/** Offline orchestration: the supplied predictor sees immutable prefixes only.
 * It owns its transport/budget gate; this function records cost, never authorizes spend.
 * No traces or results are persisted. One factory per task prevents cross-task state leakage.
 */
export async function evaluateShadow(input: readonly unknown[], factory: () => AsyncPredictor, options: Options) {
  assertDisjointTasks(options.training, input);
  const reservation = amount.parse(options.reservationMicrousd);
  const timeoutMs = z.number().int().min(1).max(60_000).parse(options.timeoutMs ?? 15_000);
  const now = options.now ?? (() => performance.now());
  const tasks: (readonly PrefixPoint[])[][] = [];
  evaluateTraces(input, () => {
    const prefixes: (readonly PrefixPoint[])[] = []; tasks.push(prefixes);
    return prefix => { prefixes.push(prefix); return null; };
  });
  const captured: (z.infer<typeof resultSchema> | undefined)[][] = [];
  const latencies: number[] = []; let chargedMicrousd = 0, errors = 0, accountingViolations = 0;
  for (const prefixes of tasks) {
    let predict: AsyncPredictor | undefined;
    if (accountingViolations === 0) {
      try { predict = factory(); } catch { /* Preserve this task's failed attempts below. */ }
    }
    const results: (z.infer<typeof resultSchema> | undefined)[] = []; captured.push(results);
    for (const prefix of prefixes) {
      if (predict === undefined || accountingViolations > 0) {
        errors++; results.push(undefined); continue;
      }
      const controller = new AbortController(); const start = now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cost = reservation;
      try {
        const raw = await Promise.race([
          Promise.resolve().then(() => predict!(independentPrefix(prefix), controller.signal)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, timeoutMs);
          })
        ]);
        const result = resultSchema.parse(raw);
        // Out-of-bound usage is an accounting failure, not a cheap or accurate prediction.
        if (result.costMicrousd !== undefined && result.costMicrousd > reservation) {
          cost = result.costMicrousd; accountingViolations++;
          throw new Error("Cost exceeds reservation");
        }
        results.push(result); cost = result.costMicrousd ?? reservation;
      } catch { errors++; results.push(undefined); }
      finally {
        clearTimeout(timer); controller.abort();
        latencies.push(Math.max(0, now() - start)); chargedMicrousd += cost;
      }
    }
  }
  let taskIndex = 0;
  const comparison = comparePredictors(input, [
    () => { const predict = baselinePredictor(); return prefix => predict(prefix.map(point => {
      const { modelEstimateSeconds: _estimate, modelConfidence: _confidence, ...local } = point;
      return local;
    })); },
    baselinePredictor,
    () => {
      const results = captured[taskIndex++]!; let index = 0;
      return () => {
        const result = results[index++];
        if (result === undefined) throw new Error("Shadow predictor failed");
        return result.prediction;
      };
    }
  ]);
  return { comparison, execution: { attempts: tasks.reduce((sum, prefixes) => sum + prefixes.length, 0),
    dispatched: latencies.length, errors, chargedMicrousd, accountingViolations,
    meanLatencyMs: latencies.length === 0 ? null : latencies.reduce((sum, value) => sum + value / latencies.length, 0) } };
}
