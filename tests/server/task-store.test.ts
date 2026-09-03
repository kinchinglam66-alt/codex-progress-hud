import { describe, expect, it, vi } from "vitest";
import { TaskStore } from "../../src/server/task-store.js";
import type { ProgressEnvelope } from "../../src/core/schema.js";

function envelope(
  taskId: string,
  title: string,
  event: ProgressEnvelope["event"]
): ProgressEnvelope {
  return { taskId, title, event };
}

function start(taskId: string, title: string): ProgressEnvelope {
  return envelope(taskId, title, { type: "turn_started" });
}

function fail(taskId: string, title: string): ProgressEnvelope {
  return envelope(taskId, title, { type: "runtime_failed", message: "failed" });
}

describe("bounded multi-task store", () => {
  it("keeps interleaved tasks and follows the most recently active nonterminal task", () => {
    const store = new TaskStore();

    store.apply(start("task-a", "Alpha"), 100);
    const snapshot = store.apply(start("task-b", "Beta"), 200);
    const latest = store.apply(
      envelope("task-a", "Alpha", { type: "activity_resumed" }),
      300
    );

    expect(latest.selectedTaskId).toBe("task-a");
    expect(latest.selectionMode).toBe("follow_activity");
    expect(latest.tasks).toEqual([
      {
        id: "task-a",
        title: "Alpha",
        status: "running",
        lastActivityAt: 300,
        hiddenForTask: false
      },
      {
        id: "task-b",
        title: "Beta",
        status: "running",
        lastActivityAt: 200,
        hiddenForTask: false
      }
    ]);
    expect(latest.selected?.task.id).toBe("task-a");
    expect(snapshot.selectedTaskId).toBe("task-b");
  });

  it("keeps a manually pinned task until it becomes terminal, then follows activity", () => {
    const store = new TaskStore();
    store.apply(start("task-a", "Alpha"), 100);
    store.apply(start("task-b", "Beta"), 200);

    const pinned = store.select("task-a", "pinned", 250);
    expect(pinned.selectedTaskId).toBe("task-a");
    expect(pinned.selectionMode).toBe("pinned");

    const whilePinned = store.apply(
      envelope("task-b", "Beta", { type: "activity_resumed" }),
      300
    );
    expect(whilePinned.selectedTaskId).toBe("task-a");
    expect(whilePinned.selectionMode).toBe("pinned");

    const afterTerminal = store.apply(fail("task-a", "Alpha"), 400);
    expect(afterTerminal.selectedTaskId).toBe("task-b");
    expect(afterTerminal.selectionMode).toBe("follow_activity");
    expect(afterTerminal.selected?.task.id).toBe("task-b");
  });

  it("stores hide state per task", () => {
    const store = new TaskStore();
    store.apply(start("task-a", "Alpha"), 100);
    store.apply(start("task-b", "Beta"), 200);

    const hidden = store.setHidden("task-a", true, 250);
    expect(hidden.tasks.find((task) => task.id === "task-a")?.hiddenForTask).toBe(true);
    expect(hidden.tasks.find((task) => task.id === "task-b")?.hiddenForTask).toBe(false);

    const updated = store.apply(envelope("task-a", "Alpha", { type: "activity_resumed" }), 300);
    expect(updated.tasks.find((task) => task.id === "task-a")?.hiddenForTask).toBe(true);
    expect(updated.tasks.find((task) => task.id === "task-b")?.hiddenForTask).toBe(false);
  });

  it("increments revisions and emits changed only for real mutations", () => {
    const store = new TaskStore();
    const changed = vi.fn();
    store.on("changed", changed);

    expect(store.snapshot().revision).toBe(0);
    const first = store.apply(start("task-a", "Alpha"), 100);
    expect(first.revision).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);

    const idempotent = store.apply(start("task-a", "Alpha"), 100);
    expect(idempotent.revision).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);

    const sameSelection = store.select("task-a", "follow_activity", 100);
    expect(sameSelection.revision).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);

    const sameHidden = store.setHidden("task-a", false, 100);
    expect(sameHidden.revision).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("records incompatible clients once and keeps repeated true updates idempotent", () => {
    const store = new TaskStore();
    const changed = vi.fn();
    store.on("changed", changed);

    const first = store.setIncompatibleClientSeen(true, 100);
    expect(first.compatibility.incompatibleClientSeen).toBe(true);
    expect(first.revision).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);

    const repeated = store.setIncompatibleClientSeen(true, 200);
    expect(repeated.compatibility.incompatibleClientSeen).toBe(true);
    expect(repeated.revision).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("ignores the requested task in follow mode and chooses the newest active task", () => {
    const store = new TaskStore();
    store.apply(start("task-a", "Alpha"), 100);
    store.apply(start("task-b", "Beta"), 200);

    const followed = store.select("task-a", "follow_activity", 250);
    expect(followed.selectedTaskId).toBe("task-b");
    expect(followed.selectionMode).toBe("follow_activity");

    store.apply(fail("task-b", "Beta"), 300);
    const terminalTarget = store.select("task-b", "follow_activity", 350);
    expect(terminalTarget.selectedTaskId).toBe("task-a");
    expect(terminalTarget.selected?.task.id).toBe("task-a");
  });

  it("reconciles a selected task evicted during select pruning", () => {
    const store = new TaskStore({ terminalRetentionMs: 100 });
    store.apply(fail("task-a", "Alpha"), 100);
    store.apply(start("task-b", "Beta"), 150);
    store.select("task-a", "pinned", 150);

    const snapshot = store.select("task-a", "pinned", 200);
    expect(snapshot.tasks.map((task) => task.id)).toEqual(["task-b"]);
    expect(snapshot.selectedTaskId).toBe("task-b");
    expect(snapshot.selected?.task.id).toBe("task-b");
  });

  it("reconciles a selected task evicted during hide-state pruning", () => {
    const store = new TaskStore({ terminalRetentionMs: 100 });
    store.apply(fail("task-a", "Alpha"), 100);
    store.apply(start("task-b", "Beta"), 150);
    store.select("task-a", "pinned", 150);

    const snapshot = store.setHidden("task-b", true, 200);
    expect(snapshot.tasks.map((task) => task.id)).toEqual(["task-b"]);
    expect(snapshot.selectedTaskId).toBe("task-b");
    expect(snapshot.selected?.task.id).toBe("task-b");
  });

  it("retains terminal tasks only through the configured retention window", () => {
    const store = new TaskStore({ maxTasks: 4, terminalRetentionMs: 1_000 });
    store.apply(fail("task-a", "Alpha"), 100);

    expect(store.sweep(1_099).tasks.map((task) => task.id)).toEqual(["task-a"]);
    expect(store.sweep(1_100).tasks).toEqual([]);
    expect(store.snapshot().selectedTaskId).toBeNull();
  });

  it("evicts terminal tasks before active tasks and breaks ties deterministically", () => {
    const store = new TaskStore({ maxTasks: 2, terminalRetentionMs: 10_000 });
    store.apply(fail("task-b", "Beta"), 100);
    store.apply(fail("task-a", "Alpha"), 100);
    const snapshot = store.apply(start("task-c", "Gamma"), 200);

    expect(snapshot.tasks.map((task) => task.id)).toEqual(["task-c", "task-a"]);
    expect(snapshot.tasks.some((task) => task.id === "task-b")).toBe(false);
    expect(snapshot.tasks.length).toBe(2);
  });
});
