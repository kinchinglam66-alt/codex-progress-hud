import type { EtaEstimate, TaskSnapshot } from "./types.js";

const NO_ACTIVE_ETA = new Set<TaskSnapshot["status"]>([
  "idle",
  "waiting_approval",
  "waiting_user",
  "stalled_suspected",
  "completed_unverified",
  "succeeded_verified",
  "failed",
  "interrupted"
]);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const roundFive = (value: number): number => Math.max(0, Math.round(value / 5) * 5);
const roundConfidence = (value: number): number => Math.round(clamp01(value) * 100) / 100;

function activeSeconds(snapshot: TaskSnapshot, nowMs: number): number {
  const running =
    snapshot.activeSince === undefined ? 0 : Math.max(0, nowMs - snapshot.activeSince);
  return (snapshot.activeElapsedMs + running) / 1_000;
}

export function estimateRemaining(
  snapshot: TaskSnapshot,
  nowMs = Date.now()
): EtaEstimate | null {
  if (NO_ACTIVE_ETA.has(snapshot.status)) return null;

  const elapsed = activeSeconds(snapshot, nowMs);
  const progress = snapshot.progress;
  const planEstimate =
    progress !== undefined && progress > 0 && progress < 1 && elapsed > 0
      ? (elapsed * (1 - progress)) / progress
      : undefined;
  const modelEstimate =
    snapshot.modelEstimateSeconds !== undefined && snapshot.modelEstimateSeconds > 0
      ? snapshot.modelEstimateSeconds
      : undefined;

  let center: number;
  let confidence: number;

  if (planEstimate !== undefined && modelEstimate !== undefined) {
    const modelWeight = clamp01(snapshot.modelConfidence ?? 0.5);
    center = modelEstimate * modelWeight + planEstimate * (1 - modelWeight);
    confidence = Math.min(0.9, 0.55 + 0.3 * modelWeight);
  } else if (planEstimate !== undefined) {
    center = planEstimate;
    confidence = 0.6;
  } else if (modelEstimate !== undefined) {
    center = modelEstimate;
    confidence = clamp01(snapshot.modelConfidence ?? 0.35) * 0.8;
  } else {
    return null;
  }

  if (snapshot.phase?.toLowerCase().includes("explor")) {
    center *= 1.25;
    confidence = Math.max(0.15, confidence - 0.15);
  }

  confidence = roundConfidence(confidence);
  const rangeFactor = 1 + (1 - confidence);

  return {
    lowSeconds: roundFive(center / rangeFactor),
    highSeconds: roundFive(center * rangeFactor),
    confidence
  };
}

