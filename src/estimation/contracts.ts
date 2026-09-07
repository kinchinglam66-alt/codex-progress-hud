import { z } from "zod";

const seconds = z.number().finite().nonnegative().max(31_536_000);
export const metricsSchema = z.object({
  activeSeconds: seconds,
  progress: z.number().finite().min(0).max(1).nullable(),
  toolCount: z.number().int().nonnegative().max(1_000_000),
  validationFailures: z.number().int().nonnegative().max(1_000_000)
}).strict();
export const predictionSchema = z.object({ lowSeconds: seconds, highSeconds: seconds }).strict()
  .refine(value => value.highSeconds >= value.lowSeconds);
export const observationSchema = z.object({
  key: z.string().min(1).max(256),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["running", "waiting", "terminal"]),
  metrics: metricsSchema
}).strict();
export type Metrics = Readonly<z.infer<typeof metricsSchema>>;
export type Observation = Readonly<z.infer<typeof observationSchema>>;
export type Prediction = Readonly<z.infer<typeof predictionSchema>>;
export interface EstimationProvider {
  readonly reservationMicrousd: number;
  estimate(metrics: Metrics, signal: AbortSignal): Promise<unknown>;
}
export interface ShadowResult {
  readonly key: string;
  readonly generation: number;
  readonly sequence: number;
  readonly prediction: Prediction;
}
