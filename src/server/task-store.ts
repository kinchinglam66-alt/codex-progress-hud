import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { estimateRemaining } from "../core/eta.js";
import { createInitialTask, reduceTask } from "../core/reducer.js";
import type { ProgressEnvelope } from "../core/schema.js";
import type { EtaEstimate, TaskSnapshot, TaskStatus } from "../core/types.js";

export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  lastActivityAt: number;
  hiddenForTask: boolean;
}

export interface HudAggregateSnapshot {
  revision: number;
  selectedTaskId: string | null;
  selectionMode: "follow_activity" | "pinned";
  tasks: TaskSummary[];
  selected: { task: TaskSnapshot; eta: EtaEstimate | null } | null;
  compatibility: { incompatibleClientSeen: boolean };
}

export type HudSnapshot = HudAggregateSnapshot;

export interface TaskStoreOptions {
  maxTasks?: number;
  terminalRetentionMs?: number;
  now?: () => number;
}

interface TaskRecord {
  task: TaskSnapshot;
  hiddenForTask: boolean;
  terminalSince: number | undefined;
  insertionOrder: number;
}

const DEFAULT_MAX_TASKS = 32;
const DEFAULT_TERMINAL_RETENTION_MS = 15 * 60 * 1_000;
const TERMINAL_STATUSES = new Set<TaskStatus>([
  "ended_unknown",
  "completed_unverified",
  "succeeded_verified",
  "failed",
  "interrupted"
]);

function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function compareRecords(left: TaskRecord, right: TaskRecord): number {
  return (
    left.task.lastActivityAt - right.task.lastActivityAt ||
    left.insertionOrder - right.insertionOrder
  );
}

export class TaskStore extends EventEmitter {
  #tasks = new Map<string, TaskRecord>();
  #selectedTaskId: string | null = null;
  #selectionMode: "follow_activity" | "pinned" = "follow_activity";
  #revision = 0;
  #nextInsertionOrder = 0;
  #incompatibleClientSeen = false;
  #maxTasks: number;
  #terminalRetentionMs: number;
  #now: () => number;

  constructor(options: TaskStoreOptions = {}) {
    super();
    this.#maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
    this.#terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#maxTasks) || this.#maxTasks < 1) {
      throw new RangeError("maxTasks must be a positive safe integer");
    }
    if (!Number.isFinite(this.#terminalRetentionMs) || this.#terminalRetentionMs < 0) {
      throw new RangeError("terminalRetentionMs must be a nonnegative finite number");
    }
  }

  apply(envelope: ProgressEnvelope, nowMs = this.#now()): HudAggregateSnapshot {
    let mutated = this.#prune(nowMs);
    const existing = this.#tasks.get(envelope.taskId);
    const current =
      existing?.task ?? createInitialTask(envelope.taskId, envelope.title, nowMs);
    const titled = current.title === envelope.title ? current : { ...current, title: envelope.title };
    const nextTask = reduceTask(titled, envelope.event, nowMs);

    if (existing === undefined) {
      this.#tasks.set(envelope.taskId, {
        task: nextTask,
        hiddenForTask: false,
        terminalSince: isTerminal(nextTask.status) ? nowMs : undefined,
        insertionOrder: this.#nextInsertionOrder++
      });
      mutated = true;
    } else if (!isDeepStrictEqual(nextTask, existing.task)) {
      existing.task = nextTask;
      if (!isTerminal(nextTask.status)) {
        existing.terminalSince = undefined;
      } else if (existing.terminalSince === undefined) {
        existing.terminalSince = nowMs;
      }
      mutated = true;
    }

    if (
      this.#selectionMode === "pinned" &&
      this.#selectedTaskId === envelope.taskId &&
      isTerminal(nextTask.status)
    ) {
      this.#selectionMode = "follow_activity";
      this.#selectedTaskId = this.#followSelection();
      mutated = true;
    }

    if (this.#reconcileSelection()) mutated = true;
    if (this.#enforceBound()) mutated = true;
    if (this.#reconcileSelection()) mutated = true;
    return this.#finishMutation(mutated, nowMs);
  }

  select(
    taskId: string,
    mode: "pinned" | "follow_activity",
    nowMs = this.#now()
  ): HudAggregateSnapshot {
    let mutated = this.#prune(nowMs);
    if (this.#reconcileSelection()) mutated = true;
    if (mode === "follow_activity") {
      if (this.#selectionMode !== mode) {
        this.#selectionMode = mode;
        mutated = true;
      }
      const nextSelected = this.#followSelection();
      if (nextSelected !== this.#selectedTaskId) {
        this.#selectedTaskId = nextSelected;
        mutated = true;
      }
    } else {
      const record = this.#tasks.get(taskId);
      if (record !== undefined && !isTerminal(record.task.status)) {
        if (this.#selectionMode !== mode || this.#selectedTaskId !== taskId) mutated = true;
        this.#selectionMode = mode;
        this.#selectedTaskId = taskId;
      }
    }
    return this.#finishMutation(mutated, nowMs);
  }

  setHidden(taskId: string, hidden: boolean, nowMs = this.#now()): HudAggregateSnapshot {
    const record = this.#tasks.get(taskId);
    let mutated = this.#prune(nowMs);
    if (this.#reconcileSelection()) mutated = true;
    if (record !== undefined && record.hiddenForTask !== hidden && this.#tasks.has(taskId)) {
      record.hiddenForTask = hidden;
      mutated = true;
    }
    return this.#finishMutation(mutated, nowMs);
  }

  setIncompatibleClientSeen(seen: boolean, nowMs = this.#now()): HudAggregateSnapshot {
    if (this.#incompatibleClientSeen === seen) return this.#finishMutation(false, nowMs);
    this.#incompatibleClientSeen = seen;
    return this.#finishMutation(true, nowMs);
  }

  snapshot(nowMs = this.#now()): HudAggregateSnapshot {
    return this.#buildSnapshot(nowMs);
  }

  sweep(nowMs = this.#now()): HudAggregateSnapshot {
    let mutated = this.#prune(nowMs) || this.#enforceBound();
    if (this.#reconcileSelection()) mutated = true;
    return this.#finishMutation(mutated, nowMs);
  }

  #finishMutation(mutated: boolean, nowMs: number): HudAggregateSnapshot {
    if (mutated) this.#revision += 1;
    const snapshot = this.#buildSnapshot(nowMs);
    if (mutated) this.emit("changed", snapshot);
    return snapshot;
  }

  #buildSnapshot(nowMs: number): HudAggregateSnapshot {
    const tasks = [...this.#tasks.values()]
      .sort(
        (left, right) =>
          right.task.lastActivityAt - left.task.lastActivityAt ||
          right.insertionOrder - left.insertionOrder
      )
      .map(({ task, hiddenForTask }) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        lastActivityAt: task.lastActivityAt,
        hiddenForTask
      }));
    const selectedRecord =
      this.#selectedTaskId === null ? undefined : this.#tasks.get(this.#selectedTaskId);
    return {
      revision: this.#revision,
      selectedTaskId: this.#selectedTaskId,
      selectionMode: this.#selectionMode,
      tasks,
      selected:
        selectedRecord === undefined
          ? null
          : { task: selectedRecord.task, eta: estimateRemaining(selectedRecord.task, nowMs) },
      compatibility: { incompatibleClientSeen: this.#incompatibleClientSeen }
    };
  }

  #prune(nowMs: number): boolean {
    let mutated = false;
    for (const [taskId, record] of this.#tasks) {
      if (
        record.terminalSince !== undefined &&
        nowMs - record.terminalSince >= this.#terminalRetentionMs
      ) {
        this.#tasks.delete(taskId);
        mutated = true;
      }
    }
    return mutated;
  }

  #enforceBound(): boolean {
    let mutated = false;
    while (this.#tasks.size > this.#maxTasks) {
      const candidate = [...this.#tasks.entries()]
        .sort(([, left], [, right]) => {
          const leftTerminal = isTerminal(left.task.status) ? 0 : 1;
          const rightTerminal = isTerminal(right.task.status) ? 0 : 1;
          return leftTerminal - rightTerminal || compareRecords(left, right);
        })[0];
      if (candidate === undefined) break;
      this.#tasks.delete(candidate[0]);
      mutated = true;
    }
    return mutated;
  }

  #followSelection(): string | null {
    const nonterminal = [...this.#tasks.values()]
      .filter(({ task }) => !isTerminal(task.status))
      .sort((left, right) => compareRecords(right, left))[0];
    if (nonterminal !== undefined) return nonterminal.task.id;
    const latest = [...this.#tasks.values()].sort((left, right) => compareRecords(right, left))[0];
    return latest?.task.id ?? null;
  }

  #reconcileSelection(): boolean {
    let mutated = false;
    if (this.#selectionMode === "pinned" && this.#selectedTaskId !== null) {
      const selected = this.#tasks.get(this.#selectedTaskId);
      if (selected === undefined) {
        this.#selectionMode = "follow_activity";
        this.#selectedTaskId = this.#followSelection();
        mutated = true;
      }
    } else if (this.#selectionMode === "follow_activity") {
      const nextSelected = this.#followSelection();
      if (nextSelected !== this.#selectedTaskId) {
        this.#selectedTaskId = nextSelected;
        mutated = true;
      }
    }
    return mutated;
  }
}
