import { z } from "zod";
import type { ProgressEvent } from "./types.js";

const planStepSchema = z.object({
  title: z.string().trim().min(1).max(160),
  status: z.enum(["pending", "in_progress", "completed"]),
  weight: z.number().finite().positive().max(100).optional()
});

export const progressEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn_started") }),
  z.object({ type: z.literal("tracking_started") }),
  z.object({ type: z.literal("tracking_paused") }),
  z.object({ type: z.literal("tracking_resumed") }),
  z.object({ type: z.literal("tracking_stopped") }),
  z.object({ type: z.literal("plan_updated"), steps: z.array(planStepSchema).max(100) }),
  z.object({
    type: z.literal("waiting"),
    reason: z.enum(["approval", "user"]),
    detail: z.string().trim().max(240).optional()
  }),
  z.object({
    type: z.literal("model_progress"),
    phase: z.string().trim().min(1).max(80),
    progress: z.number().finite().optional(),
    confidence: z.number().finite().optional(),
    remainingSeconds: z.number().finite().nonnegative().max(31_536_000).optional(),
    currentStep: z.string().trim().max(160).optional()
  }),
  z.object({
    type: z.literal("model_outcome"),
    outcome: z.enum(["completed", "blocked", "failed"]),
    verified: z.boolean(),
    detail: z.string().trim().max(240).optional()
  }),
  z.object({
    type: z.literal("runtime_failed"),
    message: z.string().trim().min(1).max(240)
  }),
  z.object({
    type: z.literal("runtime_interrupted"),
    message: z.string().trim().max(240).optional()
  }),
  z.object({
    type: z.literal("stale_detected"),
    message: z.string().trim().max(240).optional()
  }),
  z.object({ type: z.literal("activity_resumed") })
]);

export const progressEnvelopeSchema = z.object({
  taskId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(160),
  event: progressEventSchema
});

export interface ProgressEnvelope {
  taskId: string;
  title: string;
  event: ProgressEvent;
}

export function parseProgressEnvelope(value: unknown): ProgressEnvelope {
  return progressEnvelopeSchema.parse(value) as ProgressEnvelope;
}
