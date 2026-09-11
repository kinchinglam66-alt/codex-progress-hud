import {z} from 'zod';

export const invocationPhaseSchema = z.enum(['prepared', 'bound', 'dispatching', 'settling', 'closed']);
export const invocationProviderSchema = z.enum(['subscription', 'api']);
export const invocationCleanupSchema = z.enum(['pending', 'confirmed', 'unconfirmed', 'failed']);

export const invocationRecordSchema = z.object({
  admissionId: z.string().uuid(),
  conversationKey: z.string().min(1).max(512),
  turnGeneration: z.number().int().nonnegative().safe(),
  ownerUuid: z.string().uuid(),
  providerKind: invocationProviderSchema,
  phase: invocationPhaseSchema,
  deadline: z.number().int().nonnegative().safe(),
  pid: z.number().int().positive().safe().optional(),
  creationIdentity: z.string().min(1).max(256).optional(),
  cleanupOutcome: invocationCleanupSchema.optional(),
  recoveryOutcome: z.literal('abandoned_unconfirmed').optional(),
  retryAttempt: z.boolean().optional(),
  accountScope: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  recoveredAt: z.number().int().nonnegative().safe().optional(),
}).strict();

export type InvocationRecord = z.infer<typeof invocationRecordSchema>;
export type InvocationRecordPatch = Partial<Pick<InvocationRecord, 'phase' | 'deadline' | 'pid' | 'creationIdentity' | 'cleanupOutcome'>>;

export function copyInvocationRecord(value: InvocationRecord): InvocationRecord {
  const parsed = invocationRecordSchema.safeParse({...value});
  if (!parsed.success) throw new Error('RELEASE_INVOCATION_INVALID');
  return {...parsed.data};
}

export function copyInvocationPatch(value: InvocationRecordPatch): InvocationRecordPatch {
  const parsed = invocationRecordSchema.partial().pick({phase: true, deadline: true, pid: true, creationIdentity: true, cleanupOutcome: true}).strict().safeParse({...value});
  if (!parsed.success) throw new Error('RELEASE_INVOCATION_INVALID');
  // Zod's inferred optional properties include explicit undefined values,
  // while the public patch type deliberately keeps exact-optional semantics.
  return {...parsed.data} as InvocationRecordPatch;
}
