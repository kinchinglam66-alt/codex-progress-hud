export type TaskStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "waiting_user"
  | "stalled_suspected"
  | "completed_unverified"
  | "succeeded_verified"
  | "failed"
  | "interrupted";

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
}

export interface EtaEstimate {
  lowSeconds: number;
  highSeconds: number;
  confidence: number;
}

export type ProgressEvent =
  | { type: "turn_started" }
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

