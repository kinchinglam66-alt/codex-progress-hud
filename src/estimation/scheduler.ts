import { z } from "zod";
import { observationSchema, predictionSchema, type EstimationProvider, type Observation, type ShadowResult } from "./contracts.js";

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const responseSchema = z.object({ prediction: predictionSchema.nullable(), costMicrousd: money.optional() }).strict();
interface Flight { observation: Observation; controller: AbortController; started: number; settled: boolean; accounted: boolean }
interface Entry { latest: Observation; pending: boolean; last: number; starts: number[]; charged: number; flight?: Flight }
interface Options {
  provider: EstimationProvider;
  now: () => number;
  budgetMicrousd: number;
  taskBudgetMicrousd: number;
  maxTasks?: number;
  onResult: (result: ShadowResult) => void;
}

/** Source-neutral shadow core. Owner must tick on a monotonic clock and disable on shutdown.
 * The in-memory ledger is for simulations, NOT a durable paid-session spend authority.
 */
export class ShadowScheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly reservation: number;
  private readonly maxTasks: number;
  private charged = 0;
  private active = 0;
  private disabled = false;
  private accountingViolation = false;
  private lastClock = 0;
  private pumping = false;
  constructor(private readonly options: Options) {
    this.reservation = money.refine(value => value > 0).parse(options.provider.reservationMicrousd);
    money.parse(options.budgetMicrousd); money.parse(options.taskBudgetMicrousd);
    this.maxTasks = z.number().int().min(1).max(2048).parse(options.maxTasks ?? 256);
  }

  private time(): number {
    const value = this.options.now();
    if (!Number.isFinite(value) || value < this.lastClock) throw new Error("Non-monotonic clock");
    this.lastClock = value; return value;
  }

  observe(input: unknown): boolean {
    if (this.disabled) return false;
    const parsed = observationSchema.parse(input);
    const observation = Object.freeze({ ...parsed, metrics: Object.freeze(parsed.metrics) });
    let entry = this.entries.get(observation.key);
    if (entry === undefined) {
      if (this.entries.size >= this.maxTasks) return false;
      entry = { latest: observation, pending: false, last: -Infinity, starts: [], charged: 0 };
      this.entries.set(observation.key, entry);
    } else {
      const previous = entry.latest;
      if (observation.generation < previous.generation ||
        (observation.generation === previous.generation &&
          (previous.state === "terminal" || observation.sequence <= previous.sequence))) return false;
      entry.latest = observation;
      if (entry.flight && (observation.generation !== previous.generation || observation.state !== "running")) {
        this.cancel(entry);
      }
    }
    entry.pending = observation.state === "running";
    this.tick(); return true;
  }

  tick(): void {
    if (this.disabled || this.pumping) return;
    this.pumping = true;
    try {
      const now = this.time();
      for (const entry of this.entries.values()) {
        if (entry.flight && now - entry.flight.started >= 15_000) this.cancel(entry);
        entry.starts = entry.starts.filter(start => now - start < 3_600_000);
      }
      // Map order rotates after dispatch, keeping other eligible tasks ahead of a busy task.
      for (const [key, entry] of [...this.entries]) {
        if (this.active >= 2) break;
        if (!entry.pending || entry.flight || now - entry.last < 30_000 || entry.starts.length >= 20) continue;
        if (this.reservation > this.options.budgetMicrousd - this.charged ||
          this.reservation > this.options.taskBudgetMicrousd - entry.charged) continue;
        const flight: Flight = { observation: entry.latest, controller: new AbortController(), started: now, settled: false, accounted: false };
        entry.flight = flight; entry.pending = false; entry.last = now; entry.starts.push(now);
        this.charged += this.reservation; entry.charged += this.reservation; this.active++;
        this.entries.delete(key); this.entries.set(key, entry);
        // Reserve synchronously before any provider code; turn a synchronous transport throw into a rejection.
        try {
          Promise.resolve(this.options.provider.estimate(flight.observation.metrics, flight.controller.signal))
            .then(value => this.settle(entry, flight, value), () => this.settle(entry, flight, undefined));
        } catch { this.settle(entry, flight, undefined); }
      }
    } finally { this.pumping = false; }
  }

  private cancel(entry: Entry): void {
    const flight = entry.flight;
    if (!flight || flight.settled) return;
    flight.settled = true; delete entry.flight; this.active--;
    // A failed abort or a late callback must not refund this ambiguous dispatch.
    flight.controller.abort();
  }

  private settle(entry: Entry, flight: Flight, raw: unknown): void {
    if (flight.settled) { this.account(entry, flight, raw, false); return; }
    // Also enforce the deadline at completion if an owner tick was delayed.
    if (this.time() - flight.started >= 15_000) {
      this.cancel(entry); this.account(entry, flight, raw, false); this.tick(); return;
    }
    flight.settled = true; delete entry.flight; this.active--;
    this.account(entry, flight, raw, true);
    const response = responseSchema.safeParse(raw);
    if (response.success) {
      const current = entry.latest;
      if (!this.disabled && current.state === "running" && current.generation === flight.observation.generation &&
        current.sequence === flight.observation.sequence && response.data.prediction !== null) {
        try { this.options.onResult(Object.freeze({ key: current.key, generation: current.generation,
          sequence: current.sequence, prediction: Object.freeze(response.data.prediction) })); }
        catch { /* Observer failure must not break scheduling or the task. */ }
      }
    }
    this.tick();
  }

  private account(entry: Entry, flight: Flight, raw: unknown, allowRefund: boolean): void {
    if (flight.accounted) return;
    const usage = z.object({ costMicrousd: money }).safeParse(raw);
    if (!usage.success) return;
    flight.accounted = true;
    const difference = usage.data.costMicrousd - this.reservation;
    // Accounting survives prediction cancellation. Late lower usage remains reserved,
    // but a known excess must still be recorded even after another flight disabled us.
    if (difference > 0 || allowRefund) {
      this.charged += difference; entry.charged += difference;
    }
    if (difference > 0) { this.accountingViolation = true; this.disable(); }
  }

  disable(): void {
    this.disabled = true;
    for (const entry of this.entries.values()) { entry.pending = false; this.cancel(entry); }
  }

  stats() {
    return { disabled: this.disabled, accountingViolation: this.accountingViolation, chargedMicrousd: this.charged, inFlight: this.active,
      queued: [...this.entries.values()].filter(entry => entry.pending).length, trackedTasks: this.entries.size };
  }
}
