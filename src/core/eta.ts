import type { EtaEstimate, TaskSnapshot } from "./types.js";

export interface CalibrationEstimate {
  lowSeconds: number;
  highSeconds: number;
  confidence: number;
}

const NO_ACTIVE_ETA = new Set<TaskSnapshot["status"]>([
  "idle",
  "quiescent",
  "paused",
  "stopped",
  "waiting_approval",
  "waiting_user",
  "stalled_suspected",
  "disconnected_suspected",
  "ended_unknown",
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
    snapshot.status === "running" && snapshot.activeSince !== undefined
      ? Math.max(0, nowMs - snapshot.activeSince)
      : 0;
  return (snapshot.activeElapsedMs + running) / 1_000;
}

function confidenceClass(confidence: number): "low" | "medium" | "high" {
  if (confidence < 0.5) return "low";
  if (confidence < 0.75) return "medium";
  return "high";
}

export function estimateRemaining(
  snapshot: TaskSnapshot,
  nowMs = Date.now(),
  calibration?: CalibrationEstimate
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
  const calibrationEstimate =
    calibration !== undefined && calibration.highSeconds >= calibration.lowSeconds
      ? (calibration.lowSeconds + calibration.highSeconds) / 2
      : undefined;

  const signals: ("plan" | "model" | "calibration")[] = [];
  if (planEstimate !== undefined) signals.push("plan");
  if (modelEstimate !== undefined) signals.push("model");
  if (calibrationEstimate !== undefined) signals.push("calibration");
  if (signals.length === 0) return null;

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
    center = calibrationEstimate!;
    confidence = clamp01(calibration?.confidence ?? 0.35) * 0.8;
  }

  if (calibrationEstimate !== undefined && planEstimate !== undefined && modelEstimate === undefined) {
    const calibrationWeight = clamp01(calibration?.confidence ?? 0);
    center = planEstimate * (1 - calibrationWeight) + calibrationEstimate * calibrationWeight;
    confidence = Math.min(0.9, 0.6 + calibrationWeight * 0.2);
  } else if (calibrationEstimate !== undefined && (planEstimate !== undefined || modelEstimate !== undefined)) {
    const calibrationWeight = clamp01(calibration?.confidence ?? 0) * 0.5;
    center = center * (1 - calibrationWeight) + calibrationEstimate * calibrationWeight;
    confidence = Math.min(0.9, confidence * (1 - calibrationWeight) + (calibration?.confidence ?? 0) * calibrationWeight);
  }

  if (snapshot.phase?.toLowerCase().includes("explor")) {
    center *= 1.25;
    confidence = Math.max(0.15, confidence - 0.15);
  }

  const volatility = clamp01(snapshot.estimateVolatility ?? 0);
  const lateAttachmentUncertainty = snapshot.trackingOrigin === "late_attach" ? 0.4 : 0;
  confidence = roundConfidence(confidence - lateAttachmentUncertainty * 0.375);
  const rangeFactor = 1 + (1 - confidence) + volatility * 0.8 + lateAttachmentUncertainty;

  return {
    lowSeconds: roundFive(center / rangeFactor),
    highSeconds: roundFive(center * rangeFactor),
    confidence,
    confidenceClass: confidenceClass(confidence),
    signals
  };
}
