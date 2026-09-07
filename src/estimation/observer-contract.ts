import {z} from 'zod';

const seconds = z.number().finite().nonnegative().max(31_536_000);
export const observerResponseSchema = z.object({
  relation: z.enum(['continue', 'replace', 'unknown']),
  status: z.enum(['running', 'waiting', 'completed', 'unknown']),
  summary: z.string().trim().min(1).max(2048).nullable(),
  basis: z.enum(['known_wait','remaining_work','recent_pace','insufficient_context']).nullable().optional(),
  estimate: z.object({remainingSeconds: seconds,
    errorPercent: z.number().finite().min(0).max(1000)}).strict().nullable()
}).strict().superRefine((value, context) => {
  if ((value.relation === 'replace' && value.summary === null) ||
      (value.relation === 'unknown' && (value.status !== 'unknown' || value.estimate !== null || value.summary !== null)) ||
      (value.status === 'completed' && value.estimate !== null)) {
    context.addIssue({code: 'custom', message: 'inconsistent observer interpretation'});
  }
});
export type ObserverResponse = z.infer<typeof observerResponseSchema>;
const observationSchema = z.object({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  summaryThroughSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeTimeKnown: z.boolean(), historyComplete: z.boolean(),
  currentAction: z.object({text: z.string().min(1).max(2048), elapsedSeconds: seconds}).strict().nullable(),
  previousEstimate: z.object({remainingSeconds: seconds,
    errorPercent: z.number().finite().min(0).max(1000), observedActiveSeconds: seconds}).strict().nullable(),
  omittedCategories: z.array(z.enum(['user', 'assistant', 'tool', 'summary'])).max(4)
}).strict();
export const observerInputSchema = z.object({
  goalSummary: z.string().min(1).max(2048).nullable(),
  activeSeconds: seconds,
  runtime: z.enum(['running', 'waiting', 'paused']),
  messages: z.array(z.object({kind: z.enum(['user', 'assistant', 'tool']),
    text: z.string().min(1).max(4096), truncated: z.boolean()}).strict()).min(1).max(128),
  truncated: z.boolean(),
  observation: observationSchema.optional()
}).strict().refine(value => value.messages.reduce((total, message) => total + message.text.length, 0) <= 65536)
  .refine(value => !value.observation ||
    (value.observation.summaryThroughSequence <= value.observation.sequence &&
      (!value.observation.previousEstimate ||
        value.observation.previousEstimate.observedActiveSeconds <= value.activeSeconds)));
export type ObserverInput = z.infer<typeof observerInputSchema>;
