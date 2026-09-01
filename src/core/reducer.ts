import type {
  PlanStep,
  ProgressEvent,
  TaskSnapshot,
  TaskStatus
} from "./types.js";

const AUTHORITATIVE_TERMINAL = new Set<TaskStatus>(["failed", "interrupted"]);
const TERMINAL = new Set<TaskStatus>([
  "completed_unverified",
  "succeeded_verified",
  "failed",
  "interrupted"
]);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function planProgress(steps: PlanStep[]): number | undefined {
  if (steps.length === 0) return undefined;
  const total = steps.reduce((sum, step) => sum + Math.max(0, step.weight ?? 1), 0);
  if (total === 0) return undefined;
  const done = steps.reduce(
    (sum, step) => sum + (step.status === "completed" ? Math.max(0, step.weight ?? 1) : 0),
    0
  );
  return clamp01(done / total);
}

function currentPlanStep(steps: PlanStep[]): string | undefined {
  return (
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status === "pending")
  )?.title;
}

function withTiming(
  previous: TaskSnapshot,
  nextStatus: TaskStatus,
  nowMs: number
): Pick<TaskSnapshot, "activeElapsedMs" | "activeSince"> {
  const accrued =
    previous.status === "running" && previous.activeSince !== undefined
      ? Math.max(0, nowMs - previous.activeSince)
      : 0;
  return {
    activeElapsedMs: previous.activeElapsedMs + accrued,
    activeSince: nextStatus === "running" ? nowMs : undefined
  };
}

export function createInitialTask(id: string, title: string, nowMs = Date.now()): TaskSnapshot {
  return {
    id,
    title,
    status: "idle",
    statusDetail: undefined,
    phase: undefined,
    currentStep: undefined,
    progress: undefined,
    plan: [],
    createdAt: nowMs,
    startedAt: undefined,
    lastActivityAt: nowMs,
    completedAt: undefined,
    activeElapsedMs: 0,
    activeSince: undefined,
    modelEstimateSeconds: undefined,
    modelConfidence: undefined
  };
}

export function reduceTask(
  state: TaskSnapshot,
  event: ProgressEvent,
  nowMs = Date.now()
): TaskSnapshot {
  if (
    AUTHORITATIVE_TERMINAL.has(state.status) &&
    event.type !== "runtime_failed" &&
    event.type !== "runtime_interrupted"
  ) {
    return state;
  }

  let nextStatus = state.status;
  let patch: Partial<TaskSnapshot> = {};

  switch (event.type) {
    case "turn_started":
      nextStatus = "running";
      patch = {
        startedAt: state.startedAt ?? nowMs,
        statusDetail: undefined,
        completedAt: undefined
      };
      break;
    case "plan_updated":
      nextStatus = TERMINAL.has(state.status) ? state.status : "running";
      patch = {
        plan: event.steps.map((step) => ({ ...step })),
        progress: planProgress(event.steps),
        currentStep: currentPlanStep(event.steps)
      };
      break;
    case "waiting":
      nextStatus = event.reason === "approval" ? "waiting_approval" : "waiting_user";
      patch = { statusDetail: event.detail, currentStep: event.detail };
      break;
    case "model_progress":
      nextStatus = TERMINAL.has(state.status) ? state.status : "running";
      patch = {
        phase: event.phase,
        progress: event.progress === undefined ? state.progress : clamp01(event.progress),
        currentStep: event.currentStep ?? state.currentStep,
        modelEstimateSeconds:
          event.remainingSeconds === undefined
            ? state.modelEstimateSeconds
            : Math.max(0, event.remainingSeconds),
        modelConfidence:
          event.confidence === undefined ? state.modelConfidence : clamp01(event.confidence)
      };
      break;
    case "model_outcome":
      if (event.outcome === "completed") {
        nextStatus = event.verified ? "succeeded_verified" : "completed_unverified";
        patch = { progress: 1, completedAt: nowMs, statusDetail: event.detail };
      } else if (event.outcome === "failed") {
        nextStatus = "failed";
        patch = { completedAt: nowMs, statusDetail: event.detail };
      } else {
        nextStatus = "waiting_user";
        patch = { statusDetail: event.detail };
      }
      break;
    case "runtime_failed":
      nextStatus = "failed";
      patch = { statusDetail: event.message, completedAt: nowMs };
      break;
    case "runtime_interrupted":
      nextStatus = "interrupted";
      patch = { statusDetail: event.message, completedAt: nowMs };
      break;
    case "stale_detected":
      nextStatus = TERMINAL.has(state.status) ? state.status : "stalled_suspected";
      patch = { statusDetail: event.message };
      break;
    case "activity_resumed":
      nextStatus = TERMINAL.has(state.status) ? state.status : "running";
      patch = { statusDetail: undefined };
      break;
  }

  return {
    ...state,
    ...patch,
    ...withTiming(state, nextStatus, nowMs),
    status: nextStatus,
    lastActivityAt: nowMs
  };
}

