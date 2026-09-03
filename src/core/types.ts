export type TaskStatus =
  | "idle"
  | "running"
  | "quiescent"
  | "paused"
  | "stopped"
  | "waiting_approval"
  | "waiting_user"
  | "stalled_suspected"
  | "disconnected_suspected"
  | "ended_unknown"
  | "completed_unverified"
  | "succeeded_verified"
  | "failed"
  | "interrupted";

export type TrackingOrigin = "session_start" | "late_attach" | "manual";

export interface VerificationEvidence {
  kind: "validation_passed";
  observedAt: number;
}

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
  weight?: number;
}

export interface TaskSnapshot {
  id: string;
  title: string;
  status: TaskStatus;
  statusDetail: string | undefined;
  phase: string | undefined;
  currentStep: string | undefined;
  progress: number | undefined;
  plan: PlanStep[];
  createdAt: number;
  startedAt: number | undefined;
  lastActivityAt: number;
  completedAt: number | undefined;
  activeElapsedMs: number;
  activeSince: number | undefined;
  modelEstimateSeconds: number | undefined;
  modelConfidence: number | undefined;
  trackingOrigin?: TrackingOrigin;
  trackedFrom?: number;
  sessionAttachedAt?: number;
  turnStartedAt?: number;
  turnStoppedAt?: number;
  sessionEndedAt?: number;
  leaseLostAt?: number;
  lastRuntimeEvidenceAt?: number;
  estimateVolatility?: number;
  verificationEvidence?: VerificationEvidence;
}

export interface EtaEstimate {
  lowSeconds: number;
  highSeconds: number;
  confidence: number;
  confidenceClass?: "low" | "medium" | "high";
  signals?: readonly ("plan" | "model" | "calibration")[];
}

export type RuntimeEvidence =
  | { type: "session_attached"; origin: TrackingOrigin }
  | { type: "turn_started"; turnId?: string }
  | { type: "activity_seen"; category: "tool" | "hook" }
  | { type: "turn_stopped" }
  | { type: "session_ended" }
  | { type: "lease_lost" };

type SemanticProgressEvent =
  | { type: "turn_started"; turnId?: string }
  | { type: "tracking_started" }
  | { type: "tracking_paused" }
  | { type: "tracking_resumed" }
  | { type: "tracking_stopped" }
  | { type: "plan_updated"; steps: PlanStep[] }
  | { type: "waiting"; reason: "approval" | "user"; detail?: string }
  | {
      type: "model_progress";
      phase: string;
      progress?: number;
      confidence?: number;
      remainingSeconds?: number;
      currentStep?: string;
    }
  | {
      type: "model_outcome";
      outcome: "completed" | "blocked" | "failed";
      verified: boolean;
      detail?: string;
    }
  | { type: "runtime_failed"; message: string }
  | { type: "runtime_interrupted"; message?: string }
  | { type: "stale_detected"; message?: string }
  | { type: "activity_resumed" };

export type ProgressEvent = SemanticProgressEvent | RuntimeEvidence;
