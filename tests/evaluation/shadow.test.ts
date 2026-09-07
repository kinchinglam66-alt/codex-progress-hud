import { describe, expect, it } from "vitest";
import { evaluateShadow } from "../../src/evaluation/shadow.js";

const trace = (sampleKey = "sample_a", outcome = "succeeded_verified") => ({
  sampleKey, observations: [
    { atSeconds: 0, state: "running", progress: 0.1 },
    { atSeconds: 10, state: "waiting" },
    { atSeconds: 20, state: "running", progress: 0.5 }
  ], end: { atSeconds: 30, outcome }
});
const options = { training: [], reservationMicrousd: 10, timeoutMs: 1000 };
describe("asynchronous shadow evaluation", () => {
  it("does not report zero inference latency when no inference was dispatched", async () => {
    const result = await evaluateShadow([trace()], () => { throw new Error("constructor"); }, options);
    expect(result.execution).toMatchObject({ attempts: 2, dispatched: 0, meanLatencyMs: null });
  });
  it("removes cooperative model predictions before independent inference", async () => {
    const source = trace();
    const input = { ...source, observations: source.observations.map(point => ({ ...point,
      modelEstimateSeconds: 999, modelConfidence: 0.9 })) };
    const prefixes: unknown[] = [];
    await evaluateShadow([input], () => async prefix => {
      prefixes.push(prefix); return { prediction: null, costMicrousd: 0 };
    }, options);
    expect(prefixes).toHaveLength(2);
    expect(JSON.stringify(prefixes)).not.toMatch(/modelEstimateSeconds|modelConfidence|999/);
  });
  it("records known excess cost and stops further inference after an accounting violation", async () => {
    let calls = 0;
    const result = await evaluateShadow([trace()], () => async () => {
      calls++; return { prediction: null, costMicrousd: 25 };
    }, options);
    expect(result.execution).toMatchObject({ chargedMicrousd: 25, accountingViolations: 1, errors: 2, attempts: 2 });
    expect(calls).toBe(1);
  });
  it("retains per-task constructor failures without losing the other task or inventing dispatch cost", async () => {
    let factories = 0;
    const result = await evaluateShadow([trace(), trace("sample_b")], () => {
      if (++factories === 1) throw new Error("initialization");
      return async () => ({ prediction: { lowSeconds: 10, highSeconds: 20 }, costMicrousd: 2 });
    }, options);
    expect(result.execution).toMatchObject({ attempts: 4, errors: 2, chargedMicrousd: 4 });
    expect(result.comparison.predictors[2]!.all.metrics).toMatchObject({ invalid: 2, scored: 2 });
  });
  it("uses prefixes without future outcomes and reports matched horizons plus all-attempt availability", async () => {
    let now = 0; const prefixes: unknown[] = [];
    const result = await evaluateShadow([trace()], () => async prefix => {
      prefixes.push(prefix); now += 5;
      return { prediction: { lowSeconds: 10, highSeconds: 20 }, costMicrousd: 2 };
    }, { ...options, now: () => now });
    expect(prefixes).toHaveLength(2);
    expect(prefixes[0]).toEqual([{ atSeconds: 0, state: "running", progress: 0.1, activeSeconds: 0 }]);
    expect(Object.isFrozen(prefixes[0])).toBe(true);
    expect(result.comparison.commonScored).toBe(1); // cold local baseline cannot answer first point
    expect(result.comparison.predictors[2]!.all.metrics).toMatchObject({ scored: 2, coverage: 1, maeSeconds: 5 });
    expect(result.execution).toMatchObject({ attempts: 2, chargedMicrousd: 4, errors: 0, meanLatencyMs: 5 });
  });
  it("censors interrupted tasks and retains errors instead of selecting only easy predictions", async () => {
    const result = await evaluateShadow([trace("sample_a", "interrupted")], () => async () => {
      throw new Error("private failure body");
    }, options);
    expect(result.comparison.predictors[2]!.all.metrics).toMatchObject({ attempts: 2, censored: 2, invalid: 2, scored: 0 });
    expect(result.execution).toMatchObject({ errors: 2, chargedMicrousd: 20 });
    expect(JSON.stringify(result)).not.toContain("private failure body");
  });
  it("validates task disjointness before invoking any predictor", async () => {
    let calls = 0;
    await expect(evaluateShadow([trace()], () => async () => { calls++; return null; },
      { ...options, training: [trace()] })).rejects.toThrow("overlap");
    expect(calls).toBe(0);
  });
  it("does not let a hung estimator block evaluation or refund its dispatch", async () => {
    const signals: AbortSignal[] = [];
    const result = await evaluateShadow([trace()], () => (_prefix, signal) => {
      signals.push(signal); return new Promise(() => undefined);
    }, { ...options, timeoutMs: 5 });
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(result.execution).toMatchObject({ errors: 2, chargedMicrousd: 20 });
  });
});
