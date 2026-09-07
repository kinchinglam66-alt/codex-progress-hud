import {createHash} from 'node:crypto';
import type {HudSnapshot, TaskStore} from './task-store.js';

interface Scope {revision: number; digest?: string; pinned?: string}

/** Lease-local concurrency versions. Only digests/selection survive a projection. */
export class ScopedSnapshots {
  private scopes = new Map<string, Scope>();
  constructor(private readonly store: TaskStore) {}

  retain(active: ReadonlySet<string>): void {
    for (const id of this.scopes.keys()) if (!active.has(id)) this.scopes.delete(id);
  }

  select(id: string, taskId: string, mode: 'pinned'|'follow_activity'): void {
    const scope = this.scopes.get(id) ?? {revision: 0};
    if (mode === 'pinned') scope.pinned = taskId; else delete scope.pinned;
    this.scopes.set(id, scope);
  }

  project(id: string | null, snapshot: HudSnapshot, allowed: ReadonlySet<string>): HudSnapshot {
    const scope = id === null ? {revision: 0} : this.scopes.get(id) ?? {revision: 0};
    const tasks = snapshot.tasks.filter(task => allowed.has(task.id));
    const rows = (snapshot.rows ?? []).filter(row => allowed.has(row.task.id));
    if (scope.pinned !== undefined && !tasks.some(task => task.id === scope.pinned)) delete scope.pinned;
    const selectedId = scope.pinned ?? tasks.find(task => task.isCurrentTurn !== false)?.id ?? tasks[0]?.id;
    const detail = selectedId === undefined ? null : this.store.taskDetail(selectedId);
    const selected = detail === null ? null : {task: detail.task, eta: detail.eta};
    const selectionMode = scope.pinned === undefined ? 'follow_activity' : 'pinned';
    // Sampled elapsed/ETA values tick without a state mutation. Own task revision
    // stamps still detect changes that return to the same status before polling.
    const digest = createHash('sha256').update(JSON.stringify({
      tasks: tasks.map(task => [task, this.store.taskDetail(task.id)?.stamp]),
      rows: rows.map(row => ({key: row.conversationKey, name: row.name,
        goal: row.goal === undefined ? null : {generation: row.goal.generation,
          revision: row.goal.estimateRevision, status: row.goal.status, runtime: row.goal.runtime}})),
      selectedId, selectionMode
    })).digest('hex');
    if (scope.digest !== undefined && scope.digest !== digest) scope.revision++;
    scope.digest = digest;
    if (id !== null) this.scopes.set(id, scope);
    return {revision: scope.revision, tasks, rows, selected,
      selectedTaskId: selected?.task.id ?? null, selectionMode,
      compatibility: {incompatibleClientSeen: false}};
  }
}
