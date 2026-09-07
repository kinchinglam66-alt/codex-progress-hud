export type CountdownState = "running" | "waiting" | "paused" | "completed";

export interface CountdownPrediction {
  remainingSeconds: number;
  errorPercent: number;
  observedActiveSeconds: number;
}

export interface CountdownInput {
  prediction: CountdownPrediction | null;
  activeSeconds: number;
  state: CountdownState;
}

export type CountdownStatus = CountdownState | "unknown" | "overdue";

export interface CountdownProjection {
  timeText: string;
  uncertaintyText: string;
  status: CountdownStatus;
}

const MAX_SECONDS = 31_536_000;

function unknownProjection(): CountdownProjection {
  return { timeText: "Unknown", uncertaintyText: "Unknown", status: "unknown" };
}

function isFiniteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS;
}

function validPrediction(prediction: CountdownPrediction): boolean {
  return isFiniteNonnegative(prediction.remainingSeconds)
    && Number.isFinite(prediction.errorPercent)
    && prediction.errorPercent >= 0
    && prediction.errorPercent <= 1000
    && isFiniteNonnegative(prediction.observedActiveSeconds);
}

function formatSeconds(seconds: number): string {
  const displaySeconds = Math.ceil(seconds);
  const hours = Math.floor(displaySeconds / 3600);
  const minutes = Math.floor((displaySeconds % 3600) / 60);
  const remainder = displaySeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function projectCountdown(input: CountdownInput): CountdownProjection {
  if (!isFiniteNonnegative(input.activeSeconds)) return unknownProjection();

  if (input.state === "completed") {
    return { timeText: "00:00:00", uncertaintyText: "Completed", status: "completed" };
  }

  const prediction = input.prediction;
  if (prediction === null || !validPrediction(prediction)) return unknownProjection();

  const elapsed = input.activeSeconds - prediction.observedActiveSeconds;
  if (!Number.isFinite(elapsed) || elapsed < 0) return unknownProjection();

  const remaining = prediction.remainingSeconds - elapsed;
  const absoluteError = prediction.remainingSeconds * prediction.errorPercent / 100;

  if (remaining <= 0) {
    return {
      timeText: "00:00:00",
      uncertaintyText: `±${prediction.errorPercent}%`,
      status: "overdue"
    };
  }

  const uncertaintyPercent = Math.ceil(absoluteError / remaining * 100);
  if (!Number.isFinite(uncertaintyPercent)) return unknownProjection();
  return {
    timeText: formatSeconds(remaining),
    uncertaintyText: `±${uncertaintyPercent}%`,
    status: input.state
  };
}
