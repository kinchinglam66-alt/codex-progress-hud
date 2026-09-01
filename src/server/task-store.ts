import { EventEmitter } from "node:events";
import { estimateRemaining } from "../core/eta.js";
import { createInitialTask, reduceTask } from "../core/reducer.js";
import type { EtaEstimate, TaskSnapshot } from "../core/types.js";
import type { ProgressEnvelope } from "../core/schema.js";

export interface HudSnapshot {
  task: TaskSnapshot | null;
  eta: EtaEstimate | null;
}

export class TaskStore extends EventEmitter {
  #task: TaskSnapshot | null = null;

  apply(envelope: ProgressEnvelope, nowMs = Date.now()): HudSnapshot {
    const current =
      this.#task?.id === envelope.taskId
        ? this.#task
        : createInitialTask(envelope.taskId, envelope.title, nowMs);
    this.#task = reduceTask(
      current.title === envelope.title ? current : { ...current, title: envelope.title },
      envelope.event,
      nowMs
    );
    const snapshot = this.snapshot(nowMs);
    this.emit("changed", snapshot);
    return snapshot;
  }

  snapshot(nowMs = Date.now()): HudSnapshot {
    return {
      task: this.#task,
      eta: this.#task === null ? null : estimateRemaining(this.#task, nowMs)
    };
  }
}

