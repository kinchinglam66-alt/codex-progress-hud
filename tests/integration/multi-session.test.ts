import { describe, expect, it, vi } from "vitest";
import { LeaseStore } from "../../src/server/lease-store.js";
import { TaskStore } from "../../src/server/task-store.js";

describe("multi-session integration", () => {
  it("keeps two tasks isolated by MCP lease owner and expires the final leases", () => {
    let now = 0;
    let sequence = 0;
    const leases = new LeaseStore({
      monotonicNow: () => now,
      randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      minTtlMs: 10_000,
      maxTtlMs: 60_000,
      defaultTtlMs: 10_000
    });
    const expired = vi.fn();
    leases.on("expired", expired);
    const first = leases.acquire("owner-a");
    const second = leases.acquire("owner-b");
    const taskA = "hud_task_a_abcdefghijklmnopqrstuvwxyz";
    const taskB = "hud_task_b_abcdefghijklmnopqrstuvwxyz";
    expect(leases.bind(first.id, "owner-a", taskA)).toBe(true);
    expect(leases.bind(second.id, "owner-b", taskB)).toBe(true);
    expect(leases.authorize(first.id, "owner-a", taskB)).toBe(false);
    expect(leases.authorize(second.id, "owner-b", taskA)).toBe(false);

    const tasks = new TaskStore();
    tasks.apply({ taskId: taskA, event: { type: "turn_started" } }, 1);
    tasks.apply({ taskId: taskB, event: { type: "turn_started" } }, 2);
    expect(tasks.snapshot().tasks).toHaveLength(2);

    now = 10_001;
    expect(leases.sweep()).toBe(2);
    expect(leases.active()).toEqual([]);
    expect(expired).toHaveBeenCalledTimes(2);
  });
});
