import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProgressEnvelope } from "../core/schema.js";
import type { ProgressClient } from "./report-client.js";

const id = z.string().trim().min(1).max(128);
const title = z.string().trim().min(1).max(160);
export const trackingStartSchema = z.object({
  task_id: id.optional(),
  title: title.optional()
});

export const progressReportSchema = z
  .object({
    task_id: id,
    title,
    phase: z.string().trim().min(1).max(80),
    current_step: z.string().trim().max(160).optional(),
    progress: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    eta_low_seconds: z.number().nonnegative().max(31_536_000).optional(),
    eta_high_seconds: z.number().nonnegative().max(31_536_000).optional(),
    waiting_for: z.enum(["approval", "user"]).optional()
  })
  .refine(
    (value) =>
      (value.eta_low_seconds === undefined) === (value.eta_high_seconds === undefined),
    { message: "ETA low and high values must be provided together" }
  )
  .refine(
    (value) =>
      value.eta_low_seconds === undefined || value.eta_low_seconds <= value.eta_high_seconds!,
    { message: "ETA low value cannot exceed ETA high value" }
  );

export const taskOutcomeSchema = z.object({
  task_id: id,
  title,
  outcome: z.enum(["completed", "blocked", "failed"]),
  verified: z.boolean().default(false),
  detail: z.string().trim().max(240).optional()
});

export interface ToolResult extends CallToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function invalidResult(kind: string): ToolResult {
  return { content: [{ type: "text", text: `Invalid ${kind}.` }], isError: true };
}

function offlineResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: "Progress HUD is not reachable. Start the local companion and retry."
      }
    ],
    isError: true
  };
}

function noActiveTaskResult(): ToolResult {
  return { content: [{ type: "text", text: "No active task to control." }], isError: true };
}

async function submitForCurrentTask(
  client: ProgressClient,
  event: ProgressEnvelope["event"]
): Promise<ToolResult> {
  try {
    const current = await client.status();
    if (
      current.task === null ||
      current.task.id === undefined ||
      current.task.title === undefined
    ) {
      return noActiveTaskResult();
    }
    const snapshot = await client.submit({
      taskId: current.task.id,
      title: current.task.title,
      event
    });
    return textResult(
      `Tracking ${event.type.replace("tracking_", "")}: ${snapshot.task?.status ?? "idle"}.`
    );
  } catch {
    return offlineResult();
  }
}

export function createToolHandlers(client: ProgressClient) {
  return {
    async progressReport(input: unknown): Promise<ToolResult> {
      const parsed = progressReportSchema.safeParse(input);
      if (!parsed.success) return invalidResult("progress report");
      const value = parsed.data;
      let event: ProgressEnvelope["event"];
      if (value.waiting_for !== undefined) {
        event = {
          type: "waiting",
          reason: value.waiting_for,
          ...(value.current_step === undefined ? {} : { detail: value.current_step })
        };
      } else {
        const remainingSeconds =
          value.eta_low_seconds === undefined
            ? undefined
            : (value.eta_low_seconds + value.eta_high_seconds!) / 2;
        event = {
          type: "model_progress",
          phase: value.phase,
          ...(value.current_step === undefined ? {} : { currentStep: value.current_step }),
          ...(value.progress === undefined ? {} : { progress: value.progress }),
          ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
          ...(remainingSeconds === undefined ? {} : { remainingSeconds })
        };
      }
      try {
        const snapshot = await client.submit({
          taskId: value.task_id,
          title: value.title,
          event
        });
        return textResult(`Progress recorded: ${snapshot.task?.status ?? "idle"}.`);
      } catch {
        return offlineResult();
      }
    },

    async taskOutcome(input: unknown): Promise<ToolResult> {
      const parsed = taskOutcomeSchema.safeParse(input);
      if (!parsed.success) return invalidResult("task outcome");
      const value = parsed.data;
      try {
        const snapshot = await client.submit({
          taskId: value.task_id,
          title: value.title,
          event: {
            type: "model_outcome",
            outcome: value.outcome,
            verified: value.verified,
            ...(value.detail === undefined ? {} : { detail: value.detail })
          }
        });
        return textResult(`Outcome recorded: ${snapshot.task?.status ?? "idle"}.`);
      } catch {
        return offlineResult();
      }
    },

    async taskStatus(): Promise<ToolResult> {
      try {
        const snapshot = await client.status();
        return textResult(JSON.stringify(snapshot));
      } catch {
        return offlineResult();
      }
    },

    async trackingStart(input: unknown): Promise<ToolResult> {
      const parsed = trackingStartSchema.safeParse(input ?? {});
      if (!parsed.success) return invalidResult("tracking start");
      try {
        const current = await client.status();
        const taskId = parsed.data.task_id ?? current.task?.id ?? "current";
        const taskTitle = parsed.data.title ?? current.task?.title ?? "当前 Codex 任务";
        const snapshot = await client.submit({
          taskId,
          title: taskTitle,
          event: { type: "tracking_started" }
        });
        return textResult(`Tracking started: ${snapshot.task?.status ?? "idle"}.`);
      } catch {
        return offlineResult();
      }
    },

    async trackingPause(_input?: unknown): Promise<ToolResult> {
      return submitForCurrentTask(client, { type: "tracking_paused" });
    },

    async trackingResume(_input?: unknown): Promise<ToolResult> {
      return submitForCurrentTask(client, { type: "tracking_resumed" });
    },

    async trackingStop(_input?: unknown): Promise<ToolResult> {
      return submitForCurrentTask(client, { type: "tracking_stopped" });
    },

    async trackingStatus(): Promise<ToolResult> {
      return this.taskStatus();
    }
  };
}
