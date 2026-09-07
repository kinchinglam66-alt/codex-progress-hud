import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { estimateRemaining } from "../core/eta.js";
import { createInitialTask, reduceTask } from "../core/reducer.js";
import type { ProgressEnvelope } from "../core/schema.js";
import type { EtaEstimate, TaskSnapshot, TaskStatus } from "../core/types.js";
import { isVisibleStatus, type ConversationRow, type ConversationName } from './conversation-projection.js';
import type { PassiveGoalView } from './passive-goals.js';

export interface TurnMetadata {
  conversationKey: string;
  turnKey: string;
  isCurrentTurn: boolean;
}

export interface TaskSummary extends Partial<TurnMetadata> {
  id: string;
  title: string;
  status: TaskStatus;
  lastActivityAt: number;
  hiddenForTask: boolean;
}

export interface HudAggregateSnapshot {
  turnTracking?: { identityUnavailable: boolean; orderingUncertain: boolean; capacityReached: boolean };
  revision: number;
  selectedTaskId: string | null;
  selectionMode: "follow_activity" | "pinned";
  tasks: TaskSummary[];
  rows?: ConversationRow[];
  selected: { task: TaskSnapshot; eta: EtaEstimate | null } | null;
  compatibility: { incompatibleClientSeen: boolean };
  hooks?: { activitySeen: boolean; lastEventAt?: number };
}

export type HudSnapshot = HudAggregateSnapshot;

export interface TaskStoreOptions {
  maxTasks?: number;
  terminalRetentionMs?: number;
  now?: () => number;
  nameForConversation?: (key: string) => ConversationName;
  goalForConversation?: (key: string, nowMs: number) => PassiveGoalView | null;
  observerForConversation?: (key:string)=>ConversationRow['observer'];
}

interface TaskRecord {
  turn?: TurnMetadata;
  task: TaskSnapshot;
  hiddenForTask: boolean;
  terminalSince: number | undefined;
  insertionOrder: number;
  version: number;
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
  #publicationDepth = 0;
  #publicationPending = false;
  #nextInsertionOrder = 0;
  #rowOrder = new Map<string, number>();
  #nextRowOrder = 0;
  #incompatibleClientSeen = false;
  #turnTracking = { identityUnavailable: false, orderingUncertain: false, capacityReached: false };
  #maxTasks: number;
  #terminalRetentionMs: number;
  #now: () => number;
  #nameForConversation: (key: string) => ConversationName;
  #goalForConversation: TaskStoreOptions['goalForConversation'];
  #observerForConversation: TaskStoreOptions['observerForConversation'];

  constructor(options: TaskStoreOptions = {}) {
    super();
    this.#maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
    this.#terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.#now = options.now ?? Date.now;
    this.#goalForConversation = options.goalForConversation;
    this.#observerForConversation = options.observerForConversation;
    this.#nameForConversation = options.nameForConversation ?? (() => ({value:null,freshness:'unavailable'}));
    if (!Number.isSafeInteger(this.#maxTasks) || this.#maxTasks < 1) {
      throw new RangeError("maxTasks must be a positive safe integer");
    }
    if (!Number.isFinite(this.#terminalRetentionMs) || this.#terminalRetentionMs < 0) {
      throw new RangeError("terminalRetentionMs must be a nonnegative finite number");
    }
  }

  apply(envelope: ProgressEnvelope, nowMs = this.#now(), turn?: TurnMetadata): HudAggregateSnapshot {
    let mutated = this.#prune(nowMs);
    const existing = this.#tasks.get(envelope.taskId);
    if (turn !== undefined && existing?.turn !== undefined &&
        (turn.conversationKey !== existing.turn.conversationKey || turn.turnKey !== existing.turn.turnKey)) {
      throw new Error('immutable turn identity conflict');
    }
    // Admit before changing current-turn flags. Never evict another visible
    // conversation merely because a new one reports activity at capacity.
    if (existing === undefined && this.#tasks.size >= this.#maxTasks) {
      const candidate = [...this.#tasks.entries()]
        .filter(([, record]) => !this.#visibleRecord(record, nowMs) ||
          (turn?.isCurrentTurn === true && record.turn?.conversationKey === turn.conversationKey))
        .sort(([, left], [, right]) =>
          Number(!isTerminal(left.task.status)) - Number(!isTerminal(right.task.status)) || compareRecords(left, right))[0];
      if (candidate === undefined) {
        const changed = !this.#turnTracking.capacityReached;
        this.#turnTracking.capacityReached = true;
        return this.#finishMutation(mutated || changed, nowMs);
      }
      this.#tasks.delete(candidate[0]);
      mutated = true;
    }
    if (turn?.isCurrentTurn) {
      for (const [id, record] of this.#tasks) {
        if (id !== envelope.taskId && record.turn?.conversationKey === turn.conversationKey && record.turn.isCurrentTurn) {
          record.turn = { ...record.turn, isCurrentTurn: false };
          record.version++;
          mutated = true;
        }
      }
    }
    if (existing !== undefined && turn !== undefined && !isDeepStrictEqual(existing.turn, turn)) {
      existing.turn = { ...turn };
      existing.version++;
      mutated = true;
    }
    const title = envelope.title ?? existing?.task.title ?? "Codex task";
    const current =
      existing?.task ?? createInitialTask(envelope.taskId, title, nowMs);
    const titled = current.title === title ? current : { ...current, title };
    const nextTask = reduceTask(titled, envelope.event, nowMs);

    if (existing === undefined) {
      this.#tasks.set(envelope.taskId, {
        ...(turn === undefined ? {} : { turn: { ...turn } }),
        task: nextTask,
        hiddenForTask: false,
        terminalSince: isTerminal(nextTask.status) ? nowMs : undefined,
        insertionOrder: this.#nextInsertionOrder++,
        version: 0
      });
      mutated = true;
    } else if (!isDeepStrictEqual(nextTask, existing.task)) {
      existing.task = nextTask;
      existing.version++;
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

  observeTurnTracking(patch: Partial<NonNullable<HudAggregateSnapshot['turnTracking']>>): HudAggregateSnapshot {
    const next = { ...this.#turnTracking, ...patch };
    const changed = !isDeepStrictEqual(next, this.#turnTracking);
    this.#turnTracking = next;
    return this.#finishMutation(changed, this.#now());
  }

  has(taskId: string, nowMs = this.#now()): boolean {
    const record = this.#tasks.get(taskId);
    return record !== undefined && !(
      !this.#visibleRecord(record, nowMs) && record.terminalSince !== undefined &&
      nowMs - record.terminalSince >= this.#terminalRetentionMs
    );
  }

  /** Check before consuming a router/event identity; no storage mutation. */
  canAdmit(taskId: string, replacingConversation?: string): boolean {
    return this.#tasks.has(taskId) || this.#tasks.size < this.#maxTasks ||
      [...this.#tasks.values()].some(record => !this.#visibleRecord(record, this.#now()) ||
        (replacingConversation !== undefined && record.turn?.conversationKey === replacingConversation));
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
      record.version++;
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

  /** Internal projection input; callers must authorize the task before wire use. */
  taskDetail(taskId: string, nowMs = this.#now()) {
    const record = this.#tasks.get(taskId);
    return record === undefined ? null : {task: structuredClone(record.task),
      eta: estimateRemaining(record.task, nowMs), stamp: `${record.insertionOrder}:${record.version}`};
  }

  /** Local projection only. Wire exposure requires lease-filtered serialization. */
  conversationRows(nowMs = this.#now()): ConversationRow[] {
    return [...this.#tasks.values()].filter(record => this.#visibleRecord(record, nowMs))
      .sort((a, b) => this.#rowOrder.get(a.turn!.conversationKey)! - this.#rowOrder.get(b.turn!.conversationKey)!)
      .map(record => ({
        conversationKey: record.turn!.conversationKey,
        task: structuredClone(record.task),
        eta: estimateRemaining(record.task, nowMs),
        name: this.#nameForConversation(record.turn!.conversationKey),
        ...this.#projectGoal(record.turn!.conversationKey, nowMs)
      }));
  }

  refreshPresentation(): void { this.#finishMutation(true, this.#now()); }

  /** Synchronous mutations become one coherent event-stream publication. */
  publishTogether(work: () => void): void {
    this.#publicationDepth++;
    try { work(); }
    finally {
      this.#publicationDepth--;
      if (this.#publicationDepth === 0 && this.#publicationPending) {
        this.#publicationPending = false;
        this.#finishMutation(true, this.#now());
      }
    }
  }

  #projectGoal(key: string, nowMs: number): Pick<ConversationRow, 'goal'|'observer'> {
    const goal = this.#goalForConversation?.(key, nowMs);
    const observer=this.#observerForConversation?.(key);
    return goal == null ? {} : {goal: {...structuredClone(goal), sampledAtMs: nowMs},...(observer?{observer:structuredClone(observer)}:{})};
  }

  #visibleRecord(record: TaskRecord, nowMs: number): boolean {
    if (record.turn?.isCurrentTurn !== true || record.hiddenForTask) return false;
    if (this.#goalForConversation === undefined) return isVisibleStatus(record.task.status);
    const goal = this.#goalForConversation(record.turn.conversationKey, nowMs);
    return goal !== null && goal.status !== 'completed' && goal.runtime !== 'stopped';
  }

  sweep(nowMs = this.#now()): HudAggregateSnapshot {
    let mutated = this.#prune(nowMs) || this.#enforceBound();
    if (this.#reconcileSelection()) mutated = true;
    return this.#finishMutation(mutated, nowMs);
  }

  #finishMutation(mutated: boolean, nowMs: number): HudAggregateSnapshot {
    const visible = new Set([...this.#tasks.values()].filter(record => this.#visibleRecord(record, nowMs))
      .map(record => record.turn!.conversationKey));
    for (const key of this.#rowOrder.keys()) if (!visible.has(key)) this.#rowOrder.delete(key);
    for (const key of visible) if (!this.#rowOrder.has(key)) this.#rowOrder.set(key, this.#nextRowOrder++);
    if (this.#publicationDepth > 0) {
      this.#publicationPending ||= mutated;
      return this.#buildSnapshot(nowMs);
    }
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
      .map(({ task, hiddenForTask, turn }) => ({
        ...turn,
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
      // Progress/ETA have already been projected; avoid duplicating up to 32 plans.
      rows: this.conversationRows(nowMs).map(row => ({ ...row, task: { ...row.task, plan: [] } })),
      selected:
        selectedRecord === undefined
          ? null
          : { task: selectedRecord.task, eta: estimateRemaining(selectedRecord.task, nowMs) },
      compatibility: { incompatibleClientSeen: this.#incompatibleClientSeen },
      ...(Object.values(this.#turnTracking).some(Boolean) ? { turnTracking: { ...this.#turnTracking } } : {})
    };
  }

  #prune(nowMs: number): boolean {
    let mutated = false;
    for (const [taskId, record] of this.#tasks) {
      if (
        !this.#visibleRecord(record, nowMs) && record.terminalSince !== undefined &&
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
        .filter(([, record]) => !this.#visibleRecord(record, this.#now()))
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
    const eligible = [...this.#tasks.values()].filter(record => record.turn?.isCurrentTurn !== false);
    const nonterminal = eligible
      .filter(({ task }) => !isTerminal(task.status))
      .sort((left, right) => compareRecords(right, left))[0];
    if (nonterminal !== undefined) return nonterminal.task.id;
    const latest = eligible.sort((left, right) => compareRecords(right, left))[0];
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
