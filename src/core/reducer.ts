import type {
  PlanStep,
  ProgressEvent,
  TaskSnapshot,
  TaskStatus,
  TrackingOrigin
} from "./types.js";

const AUTHORITATIVE_TERMINAL = new Set<TaskStatus>(["failed", "interrupted"]);
const SEMANTIC_TERMINAL = new Set<TaskStatus>([
  "completed_unverified",
  "succeeded_verified",
  "ended_unknown",
  "failed",
  "interrupted"
]);
const MANUAL_INACTIVE = new Set<TaskStatus>(["paused", "stopped"]);
const CONTROL_EVENTS = new Set<ProgressEvent["type"]>([
  "tracking_started",
  "tracking_paused",
  "tracking_resumed",
  "tracking_stopped"
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

function plansDiffer(previous: PlanStep[], next: PlanStep[]): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function increaseVolatility(previous: TaskSnapshot, amount: number): number {
  return clamp01((previous.estimateVolatility ?? 0) + amount);
}

function decreaseVolatility(previous: TaskSnapshot, amount: number): number {
  return clamp01((previous.estimateVolatility ?? 0) - amount);
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

function isAuthoritativeEvent(event: ProgressEvent): boolean {
  return event.type === "runtime_failed" || event.type === "runtime_interrupted";
}

function isSessionBoundaryEvent(event: ProgressEvent): boolean {
  return event.type === "session_ended" || event.type === "lease_lost";
}

function isRecoveryEvent(event: ProgressEvent): boolean {
  return (
    event.type === "session_attached" ||
    event.type === "turn_started" ||
    event.type === "activity_seen"
  );
}

function isIdempotentControl(state: TaskSnapshot, event: ProgressEvent): boolean {
  return (
    (event.type === "tracking_paused" && state.status === "paused") ||
    (event.type === "tracking_resumed" && state.status === "running") ||
    (event.type === "tracking_stopped" && state.status === "stopped") ||
    (event.type === "tracking_started" && state.status === "running")
  );
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
    modelConfidence: undefined,
    estimateVolatility: 0
  };
}

export function reduceTask(
  state: TaskSnapshot,
  event: ProgressEvent,
  nowMs = Date.now()
): TaskSnapshot {
  if (isIdempotentControl(state, event)) return state;
  if (AUTHORITATIVE_TERMINAL.has(state.status)) return state;
  if (SEMANTIC_TERMINAL.has(state.status) && !isAuthoritativeEvent(event)) {
    if (!(state.status === "ended_unknown" && isRecoveryEvent(event))) return state;
  }
  if (
    MANUAL_INACTIVE.has(state.status) &&
    !CONTROL_EVENTS.has(event.type) &&
    !isAuthoritativeEvent(event) &&
    !isSessionBoundaryEvent(event)
  ) {
    return state;
  }

  let nextStatus = state.status;
  let patch: Partial<TaskSnapshot> = {};
  const runtimePatch: Partial<TaskSnapshot> = {};

  switch (event.type) {
    case "turn_started":
      nextStatus = "running";
      patch = {
        startedAt: state.startedAt ?? nowMs,
        turnStartedAt: nowMs,
        statusDetail: undefined,
        completedAt: undefined,
        ...(state.trackingOrigin === undefined
          ? { trackingOrigin: "session_start" as TrackingOrigin, trackedFrom: nowMs }
          : {})
      };
      runtimePatch.lastRuntimeEvidenceAt = nowMs;
      break;
    case "tracking_started":
      nextStatus = "running";
      patch = {
        startedAt: state.startedAt ?? nowMs,
        trackingOrigin: "manual",
        trackedFrom: state.trackedFrom ?? nowMs,
        statusDetail: undefined,
        completedAt: undefined
      };
      break;
    case "tracking_paused":
      nextStatus = state.status === "running" ? "paused" : state.status;
      break;
    case "tracking_resumed":
      nextStatus = state.status === "paused" ? "running" : state.status;
      patch = { statusDetail: undefined };
      break;
    case "tracking_stopped":
      nextStatus =
        state.status === "running" || state.status === "paused" ? "stopped" : state.status;
      patch = { completedAt: undefined };
      break;
    case "session_attached":
      nextStatus =
        state.status === "idle" ||
        state.status === "quiescent" ||
        state.status === "stalled_suspected" ||
        state.status === "disconnected_suspected" ||
        state.status === "ended_unknown"
          ? "running"
          : state.status;
      patch = {
        startedAt: nextStatus === "running" ? state.startedAt ?? nowMs : state.startedAt,
        sessionAttachedAt: nowMs,
        ...(state.trackingOrigin === undefined
          ? { trackingOrigin: event.origin, trackedFrom: nowMs }
          : {}),
        statusDetail: nextStatus === "running" ? undefined : state.statusDetail
      };
      runtimePatch.lastRuntimeEvidenceAt = nowMs;
      break;
    case "activity_seen":
      nextStatus =
        state.status === "idle" ||
        state.status === "quiescent" ||
        state.status === "stalled_suspected" ||
        state.status === "disconnected_suspected" ||
        state.status === "ended_unknown"
          ? "running"
          : state.status;
      patch = {
        startedAt: nextStatus === "running" ? state.startedAt ?? nowMs : state.startedAt,
        statusDetail: nextStatus === "running" ? undefined : state.statusDetail,
        ...(state.trackingOrigin === undefined
          ? { trackingOrigin: "session_start" as TrackingOrigin, trackedFrom: nowMs }
          : {})
      };
      runtimePatch.lastRuntimeEvidenceAt = nowMs;
      break;
    case "turn_stopped":
      nextStatus = state.status === "running" ? "quiescent" : state.status;
      patch = { turnStoppedAt: nowMs };
      runtimePatch.lastRuntimeEvidenceAt = nowMs;
      break;
    case "session_ended":
      nextStatus = "ended_unknown";
      patch = { sessionEndedAt: nowMs };
      runtimePatch.lastRuntimeEvidenceAt = nowMs;
      break;
    case "lease_lost":
      nextStatus = "disconnected_suspected";
      patch = { leaseLostAt: nowMs };
      runtimePatch.lastRuntimeEvidenceAt = nowMs;
      break;
    case "plan_updated": {
      nextStatus = SEMANTIC_TERMINAL.has(state.status) ? state.status : "running";
      const changed = plansDiffer(state.plan, event.steps);
      patch = {
        plan: event.steps.map((step) => ({ ...step })),
        progress: planProgress(event.steps),
        currentStep: currentPlanStep(event.steps),
        estimateVolatility: changed
          ? increaseVolatility(state, 0.25)
          : state.estimateVolatility ?? 0
      };
      break;
    }
    case "waiting":
      nextStatus = event.reason === "approval" ? "waiting_approval" : "waiting_user";
      patch = { statusDetail: event.detail, currentStep: event.detail };
      break;
    case "validation_observed":
      patch = {
        verificationEvidence: {
          kind: event.result === "passed" ? "validation_passed" : "validation_failed",
          observedAt: nowMs
        }
      };
      break;
    case "model_progress": {
      nextStatus = SEMANTIC_TERMINAL.has(state.status) ? state.status : "running";
      const phaseChanged = state.phase !== undefined && state.phase !== event.phase;
      patch = {
        phase: event.phase,
        progress: event.progress === undefined ? state.progress : clamp01(event.progress),
        currentStep: event.currentStep ?? state.currentStep,
        modelEstimateSeconds:
          event.remainingSeconds === undefined
            ? state.modelEstimateSeconds
            : Math.max(0, event.remainingSeconds),
        modelConfidence:
          event.confidence === undefined ? state.modelConfidence : clamp01(event.confidence),
        estimateVolatility: phaseChanged
          ? increaseVolatility(state, 0.15)
          : decreaseVolatility(state, 0.05)
      };
      break;
    }
    case "model_outcome":
      if (event.outcome === "completed") {
        const validationPassed = state.verificationEvidence?.kind === "validation_passed";
        nextStatus = event.verified && validationPassed ? "succeeded_verified" : "completed_unverified";
        patch = {
          progress: 1,
          completedAt: nowMs,
          statusDetail: event.detail,
        };
      } else if (event.outcome === "failed") {
        nextStatus = "failed";
        patch = {
          completedAt: nowMs,
          statusDetail: event.detail,
          estimateVolatility: increaseVolatility(state, 0.25)
        };
      } else {
        nextStatus = "waiting_user";
        patch = { statusDetail: event.detail, estimateVolatility: increaseVolatility(state, 0.15) };
      }
      break;
    case "runtime_failed":
      nextStatus = "failed";
      patch = { statusDetail: event.message, completedAt: nowMs };
      runtimePatch.lastRuntimeEvidenceAt = nowMs;
      break;
    case "runtime_interrupted":
      nextStatus = "interrupted";
      patch = { statusDetail: event.message, completedAt: nowMs };
      runtimePatch.lastRuntimeEvidenceAt = nowMs;
      break;
    case "stale_detected":
      nextStatus = SEMANTIC_TERMINAL.has(state.status) ? state.status : "stalled_suspected";
      patch = { statusDetail: event.message, estimateVolatility: increaseVolatility(state, 0.2) };
      break;
    case "activity_resumed":
      nextStatus = SEMANTIC_TERMINAL.has(state.status) ? state.status : "running";
      patch = { statusDetail: undefined };
      break;
  }

  return {
    ...state,
    ...patch,
    ...runtimePatch,
    ...withTiming(state, nextStatus, nowMs),
    status: nextStatus,
    lastActivityAt: nowMs
  };
}
