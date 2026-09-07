import {z} from 'zod';

/** Public writes are user controls only. Runtime observations arrive via Hooks. */
export const controlEnvelopeSchema = z.object({
  taskId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(160).optional(),
  event: z.object({type: z.enum([
    'tracking_started', 'tracking_paused', 'tracking_resumed', 'tracking_stopped'
  ])}).strict()
}).strict();
