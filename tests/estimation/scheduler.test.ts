import { describe, expect, it } from "vitest";
import { ShadowScheduler } from "../../src/estimation/scheduler.js";

const observation = (key = "a", sequence = 1, generation = 1) => ({
  key, sequence, generation, state: "running" as const,
  metrics: { activeSeconds: 10, progress: 0.2, toolCount: 2, validationFailures: 0 }
});
const prediction = { lowSeconds: 10, highSeconds: 20 };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup(budgetMicrousd = 100, maxTasks = 32) {
  let now = 0;
  const calls: { metrics: unknown; signal: AbortSignal; resolve: (result: unknown) => void; reject: () => void }[] = [];
  const results: unknown[] = [];
  const scheduler = new ShadowScheduler({
    provider: { reservationMicrousd: 10, estimate: (metrics, signal) => new Promise((resolve, reject) => {
      calls.push({ metrics, signal, resolve, reject: () => reject(new Error("transport")) });
    }) },
    now: () => now, budgetMicrousd, taskBudgetMicrousd: budgetMicrousd, maxTasks,
    onResult: result => results.push(result)
  });
  return { scheduler, calls, results, advance: (ms: number) => { now += ms; scheduler.tick(); } };
}

describe("shadow scheduler", () => {
  it("accounts late excess costs after another flight disabled prediction publication", async () => {
    const h = setup(); h.scheduler.observe(observation("a")); h.scheduler.observe(observation("b"));
    h.calls[0]!.resolve({ prediction, costMicrousd: 25 }); await flush();
    expect(h.calls[1]!.signal.aborted).toBe(true);
    h.calls[1]!.resolve({ prediction, costMicrousd: 25 }); await flush();
    expect(h.scheduler.stats()).toMatchObject({ chargedMicrousd: 50, accountingViolation: true, inFlight: 0 });
    expect(h.results).toHaveLength(0);
  });
  it("records known excess spend and stops all dispatches on a broken reservation bound", async () => {
    const h = setup(); h.scheduler.observe(observation());
    h.calls[0]!.resolve({ prediction, costMicrousd: 25 }); await flush();
    expect(h.scheduler.stats()).toMatchObject({ chargedMicrousd: 25, accountingViolation: true, disabled: true });
    h.scheduler.observe(observation("b")); expect(h.calls).toHaveLength(1);
    expect(h.results).toHaveLength(0);
  });
  it("bounds concurrency, queues fairly and coalesces to the newest observation", async () => {
    const h = setup();
    h.scheduler.observe(observation("a")); h.scheduler.observe(observation("b"));
    h.scheduler.observe(observation("c")); h.scheduler.observe(observation("a", 2));
    expect(h.calls).toHaveLength(2);
    h.calls[0]!.resolve({ prediction, costMicrousd: 2 }); await flush();
    expect(h.results).toHaveLength(0); // sequence 1 is already stale
    expect(h.calls).toHaveLength(3); // c, not a again before cooldown
    h.advance(30_000);
    expect(h.calls).toHaveLength(4); // expired b/c free slots; newest a runs
    h.calls[3]!.resolve({ prediction, costMicrousd: 2 }); await flush();
    expect(h.results).toEqual([{ key: "a", generation: 1, sequence: 2, prediction }]);
  });

  it("does not retarget old generation callbacks, even after cancellation frees a slot", async () => {
    const h = setup();
    h.scheduler.observe(observation()); h.scheduler.observe(observation("a", 1, 2));
    expect(h.calls[0]!.signal.aborted).toBe(true);
    h.calls[0]!.resolve({ prediction, costMicrousd: 0 }); await flush();
    expect(h.results).toHaveLength(0);
    expect(h.scheduler.stats().chargedMicrousd).toBe(10);
    h.advance(30_000); expect(h.calls).toHaveLength(2);
    h.calls[1]!.resolve({ prediction, costMicrousd: 1 }); await flush();
    expect(h.results).toEqual([{ key: "a", generation: 2, sequence: 1, prediction }]);
  });

  it("retains ambiguous timeout charges so another request cannot exceed the cap", async () => {
    const h = setup(20);
    h.scheduler.observe(observation("a")); h.scheduler.observe(observation("b"));
    h.scheduler.observe(observation("c")); h.advance(15_000);
    expect(h.calls.every(call => call.signal.aborted)).toBe(true);
    h.calls[0]!.resolve({ prediction, costMicrousd: 0 }); await flush();
    expect(h.scheduler.stats()).toMatchObject({ chargedMicrousd: 20, inFlight: 0 });
    h.advance(60_000); expect(h.calls).toHaveLength(2);
    expect(h.results).toHaveLength(0);
  });

  it("terminal state is sticky within a generation and disable prevents any restart", async () => {
    const h = setup();
    h.scheduler.observe(observation());
    h.scheduler.observe({ ...observation("a", 2), state: "terminal" });
    h.scheduler.observe(observation("a", 3)); h.advance(30_000);
    expect(h.calls).toHaveLength(1);
    h.scheduler.disable(); h.scheduler.observe(observation("b"));
    h.calls[0]!.resolve({ prediction }); await flush();
    expect(h.calls).toHaveLength(1); expect(h.results).toHaveLength(0);
  });

  it("rejects invalid output and treats errors as charged rather than successful estimates", async () => {
    const h = setup(); h.scheduler.observe(observation());
    h.calls[0]!.resolve({ prediction: { lowSeconds: 30, highSeconds: 2 } }); await flush();
    expect(h.results).toHaveLength(0);
    h.advance(30_000); h.scheduler.observe(observation("a", 2));
    h.calls[1]!.reject(); await flush();
    expect(h.scheduler.stats()).toMatchObject({ chargedMicrousd: 20, inFlight: 0 });
  });

  it("copies metrics and never sends task identity or additional strings to the provider", () => {
    const h = setup(); const input = observation(); h.scheduler.observe(input);
    input.metrics.progress = 0.9;
    expect(h.calls[0]!.metrics).toEqual({ activeSeconds: 10, progress: 0.2, toolCount: 2, validationFailures: 0 });
    expect(() => h.scheduler.observe({ ...observation("b"), metrics: { ...input.metrics, prompt: "private" } })).toThrow();
  });

  it("does not forget task accounting when capacity is exhausted or generation changes", async () => {
    const h = setup(10, 1); h.scheduler.observe(observation());
    expect(h.scheduler.observe(observation("b"))).toBe(false);
    h.calls[0]!.resolve({ prediction, costMicrousd: 10 }); await flush();
    h.advance(30_000); h.scheduler.observe(observation("a", 1, 2));
    expect(h.calls).toHaveLength(1);
  });

  it("limits rolling-hour dispatches and permits a later fresh observation after the window", async () => {
    const h = setup(1000);
    for (let i = 0; i < 21; i++) {
      h.scheduler.observe(observation("a", i + 1));
      h.calls.at(-1)!.resolve({ prediction, costMicrousd: 0 }); await flush(); h.advance(30_000);
    }
    expect(h.calls).toHaveLength(20);
    h.advance(3_600_000); expect(h.calls).toHaveLength(21);
  });
});
