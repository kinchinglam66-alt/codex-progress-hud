import { describe, expect, it } from "vitest";
import { createInitialTask, reduceTask } from "../../src/core/reducer.js";
import { parseProgressEnvelope } from "../../src/core/schema.js";
import type { ProgressEvent } from "../../src/core/types.js";

function runtimeEvent(type: string, fields: Record<string, unknown> = {}): ProgressEvent {
  return { type, ...fields } as ProgressEvent;
}

describe("task lifecycle reducer", () => {
  it("moves a task from idle to running when a turn starts", () => {
    const initial = createInitialTask("task-1", "Fix login", 1_000);
    const next = reduceTask(initial, { type: "turn_started" }, 2_000);

    expect(next.status).toBe("running");
    expect(next.startedAt).toBe(2_000);
    expect(next.lastActivityAt).toBe(2_000);
  });

  it("derives determinate progress from completed plan steps", () => {
    const initial = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      { type: "turn_started" },
      1_000
    );
    const next = reduceTask(
      initial,
      {
        type: "plan_updated",
        steps: [
          { title: "Inspect", status: "completed" },
          { title: "Implement", status: "in_progress" },
          { title: "Verify", status: "pending" }
        ]
      },
      2_000
    );

    expect(next.progress).toBeCloseTo(1 / 3);
    expect(next.currentStep).toBe("Implement");
  });

  it("represents approval as waiting instead of interruption", () => {
    const initial = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      { type: "turn_started" },
      1_000
    );
    const next = reduceTask(
      initial,
      { type: "waiting", reason: "approval", detail: "Allow npm install" },
      3_000
    );

    expect(next.status).toBe("waiting_approval");
    expect(next.currentStep).toBe("Allow npm install");
  });

  it("clamps cooperative model progress to a safe range", () => {
    const initial = createInitialTask("task-1", "Fix login", 1_000);
    const next = reduceTask(
      initial,
      {
        type: "model_progress",
        phase: "implementation",
        progress: 1.7,
        confidence: 0.8,
        remainingSeconds: 240
      },
      2_000
    );

    expect(next.progress).toBe(1);
    expect(next.modelEstimateSeconds).toBe(240);
    expect(next.modelConfidence).toBe(0.8);
  });

  it("does not let a model report override an explicit runtime failure", () => {
    const initial = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      { type: "runtime_failed", message: "connection lost" },
      2_000
    );
    const next = reduceTask(
      initial,
      { type: "model_progress", phase: "done", progress: 1, confidence: 1 },
      3_000
    );

    expect(next.status).toBe("failed");
    expect(next.statusDetail).toBe("connection lost");
  });

  it("distinguishes unverified completion from verified success", () => {
    const initial = createInitialTask("task-1", "Fix login", 1_000);
    const unverified = reduceTask(
      initial,
      { type: "model_outcome", outcome: "completed", verified: false },
      2_000
    );
    const legacyVerifiedOnly = reduceTask(
      initial,
      { type: "model_outcome", outcome: "completed", verified: true },
      2_000
    );
    const validationObserved = reduceTask(
      initial,
      runtimeEvent("validation_observed", { result: "passed" }),
      1_500
    );
    const verified = reduceTask(
      validationObserved,
      { type: "model_outcome", outcome: "completed", verified: true },
      2_000
    );

    expect(unverified.status).toBe("completed_unverified");
    expect(legacyVerifiedOnly.status).toBe("completed_unverified");
    expect(legacyVerifiedOnly.verificationEvidence).toBeUndefined();
    expect(verified.status).toBe("succeeded_verified");
    expect(verified.verificationEvidence).toEqual({
      kind: "validation_passed",
      observedAt: 1_500
    });
  });

  it("does not treat a failed validation observation as proof of success", () => {
    const validationFailed = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      runtimeEvent("validation_observed", { result: "failed" }),
      1_500
    );
    const outcome = reduceTask(
      validationFailed,
      { type: "model_outcome", outcome: "completed", verified: true },
      2_000
    );

    expect(outcome.status).toBe("completed_unverified");
    expect(outcome.verificationEvidence).toEqual({
      kind: "validation_failed",
      observedAt: 1_500
    });
  });

  it("keeps an explicit interruption terminal", () => {
    const initial = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      { type: "runtime_interrupted", message: "process exited" },
      2_000
    );
    const next = reduceTask(
      initial,
      { type: "model_outcome", outcome: "completed", verified: true },
      3_000
    );

    expect(next.status).toBe("interrupted");
  });

  it("starts, pauses, resumes, and stops tracking without losing active time", () => {
    const initial = createInitialTask("task-1", "Fix login", 1_000);
    const started = reduceTask(
      initial,
      { type: "tracking_started" },
      2_000
    );
    const paused = reduceTask(started, { type: "tracking_paused" }, 5_000);
    const resumed = reduceTask(paused, { type: "tracking_resumed" }, 7_000);
    const stopped = reduceTask(resumed, { type: "tracking_stopped" }, 11_000);

    expect(started.status).toBe("running");
    expect(started.activeElapsedMs).toBe(0);
    expect(paused.status).toBe("paused");
    expect(paused.activeElapsedMs).toBe(3_000);
    expect(resumed.status).toBe("running");
    expect(resumed.activeElapsedMs).toBe(3_000);
    expect(stopped.status).toBe("stopped");
    expect(stopped.activeElapsedMs).toBe(7_000);
    expect(stopped.activeSince).toBeUndefined();
  });

  it("does not let cooperative reports reactivate explicitly paused or stopped tracking", () => {
    const initial = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      { type: "tracking_started" },
      2_000
    );
    const paused = reduceTask(initial, { type: "tracking_paused" }, 3_000);
    const pausedReport = reduceTask(
      paused,
      { type: "model_progress", phase: "testing", progress: 0.7 },
      4_000
    );
    const stopped = reduceTask(initial, { type: "tracking_stopped" }, 5_000);
    const stoppedReport = reduceTask(
      stopped,
      { type: "turn_started" },
      6_000
    );

    expect(pausedReport).toEqual(paused);
    expect(stoppedReport).toEqual(stopped);
  });

  it("moves a stopped turn to quiescent without treating it as completion", () => {
    const running = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      runtimeEvent("turn_started", { turnId: "turn-1" }),
      2_000
    );
    const next = reduceTask(running, runtimeEvent("turn_stopped"), 5_000);

    expect(next.status).toBe("quiescent");
    expect(next.completedAt).toBeUndefined();
    expect(next.turnStoppedAt).toBe(5_000);
    expect(next.activeElapsedMs).toBe(3_000);
  });

  it("marks a nonterminal task ended unknown when its session ends", () => {
    const running = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      runtimeEvent("session_attached", { origin: "session_start" }),
      2_000
    );
    const next = reduceTask(running, runtimeEvent("session_ended"), 7_000);

    expect(next.status).toBe("ended_unknown");
    expect(next.sessionEndedAt).toBe(7_000);
    expect(next.activeElapsedMs).toBe(5_000);
  });

  it.each(["paused", "stopped"] as const)(
    "classifies SessionEnd as ended unknown even when tracking is %s",
    (status) => {
      const started = reduceTask(
        createInitialTask("task-1", "Fix login", 1_000),
        { type: "tracking_started" },
        2_000
      );
      const inactive =
        status === "paused"
          ? reduceTask(started, { type: "tracking_paused" }, 3_000)
          : reduceTask(started, { type: "tracking_stopped" }, 3_000);

      expect(reduceTask(inactive, runtimeEvent("session_ended"), 4_000).status).toBe(
        "ended_unknown"
      );
    }
  );

  it.each(["paused", "stopped"] as const)(
    "classifies lease loss as disconnected even when tracking is %s",
    (status) => {
      const started = reduceTask(
        createInitialTask("task-1", "Fix login", 1_000),
        { type: "tracking_started" },
        2_000
      );
      const inactive =
        status === "paused"
          ? reduceTask(started, { type: "tracking_paused" }, 3_000)
          : reduceTask(started, { type: "tracking_stopped" }, 3_000);

      expect(reduceTask(inactive, runtimeEvent("lease_lost"), 4_000).status).toBe(
        "disconnected_suspected"
      );
    }
  );

  it("lets authoritative runtime failure replace an unverified or verified semantic outcome", () => {
    const initial = createInitialTask("task-1", "Fix login", 1_000);
    const unverified = reduceTask(
      initial,
      { type: "model_outcome", outcome: "completed", verified: false },
      2_000
    );
    const verified = reduceTask(
      initial,
      { type: "model_outcome", outcome: "completed", verified: true },
      2_000
    );

    expect(reduceTask(unverified, runtimeEvent("runtime_failed", { message: "crash" }), 3_000).status)
      .toBe("failed");
    expect(reduceTask(verified, runtimeEvent("runtime_interrupted", { message: "cancelled" }), 3_000).status)
      .toBe("interrupted");
    expect(reduceTask(verified, { type: "model_outcome", outcome: "completed", verified: false }, 4_000))
      .toEqual(verified);
  });

  it("recovers a disconnected task when fresh runtime activity is observed", () => {
    const attached = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      runtimeEvent("session_attached", { origin: "late_attach" }),
      2_000
    );
    const disconnected = reduceTask(attached, runtimeEvent("lease_lost"), 5_000);
    const recovered = reduceTask(disconnected, runtimeEvent("activity_seen", { category: "hook" }), 20_000);

    expect(attached.trackingOrigin).toBe("late_attach");
    expect(attached.trackedFrom).toBe(2_000);
    expect(disconnected.status).toBe("disconnected_suspected");
    expect(disconnected.activeElapsedMs).toBe(3_000);
    expect(recovered.status).toBe("running");
    expect(recovered.activeElapsedMs).toBe(3_000);
    expect(recovered.activeSince).toBe(20_000);
  });

  it("makes repeated pause, resume, and stop controls idempotent", () => {
    const running = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      { type: "tracking_started" },
      2_000
    );
    const paused = reduceTask(running, { type: "tracking_paused" }, 3_000);
    const pausedAgain = reduceTask(paused, { type: "tracking_paused" }, 4_000);
    const resumed = reduceTask(paused, { type: "tracking_resumed" }, 5_000);
    const resumedAgain = reduceTask(resumed, { type: "tracking_resumed" }, 6_000);
    const stopped = reduceTask(resumed, { type: "tracking_stopped" }, 7_000);
    const stoppedAgain = reduceTask(stopped, { type: "tracking_stopped" }, 8_000);

    expect(pausedAgain).toEqual(paused);
    expect(resumedAgain).toEqual(resumed);
    expect(stoppedAgain).toEqual(stopped);
  });

  it("does not add active time while quiescent, waiting, or disconnected", () => {
    const running = reduceTask(
      createInitialTask("task-1", "Fix login", 1_000),
      runtimeEvent("session_attached", { origin: "session_start" }),
      2_000
    );
    const quiescent = reduceTask(running, runtimeEvent("turn_stopped"), 4_000);
    const waiting = reduceTask(quiescent, { type: "waiting", reason: "user" }, 6_000);
    const disconnected = reduceTask(waiting, runtimeEvent("lease_lost"), 8_000);
    const later = reduceTask(disconnected, runtimeEvent("activity_seen", { category: "tool" }), 30_000);

    expect(quiescent.activeElapsedMs).toBe(2_000);
    expect(waiting.activeElapsedMs).toBe(2_000);
    expect(disconnected.activeElapsedMs).toBe(2_000);
    expect(later.activeElapsedMs).toBe(2_000);
  });

  it("keeps a legacy progress envelope parseable alongside runtime evidence", () => {
    expect(
      parseProgressEnvelope({
        taskId: "task-1",
        title: "Fix login",
        event: { type: "model_progress", phase: "testing", progress: 0.5 }
      }).event
    ).toEqual({ type: "model_progress", phase: "testing", progress: 0.5 });
    expect(
      parseProgressEnvelope({
        taskId: "task-1",
        title: "Fix login",
        event: { type: "validation_observed", result: "passed" }
      }).event
    ).toEqual({ type: "validation_observed", result: "passed" });
  });
});
