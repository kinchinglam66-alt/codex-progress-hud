/** Execution-facing accounting contract. Implementations own durable admission.
 * Null settlement means unknown usage, never a free or unlaunched call.
 */
export interface AccountedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
}
import type {InvocationRecord, InvocationRecordPatch} from './invocation-ownership.js';

export type AdmissionKind = 'ordinary' | 'retry' | 'half_open';
export type AccountingPurpose = 'eta' | 'context_compression';
export type SettlementClassification = 'known_success' | 'known_non_success' | 'safe_unknown' | 'unsafe_unknown' | 'abandoned_unconfirmed';

export interface SubscriptionAccounting {
  reserve(admissionKind?: AdmissionKind, purpose?: AccountingPurpose): Promise<string | null>;
  settle(id: string, usage: AccountedUsage | null, classification?: SettlementClassification): Promise<void>;
  bindInvocation?(id: string, record: InvocationRecord): Promise<void>;
  updateInvocation?(id: string, patch: InvocationRecordPatch): Promise<void>;
  /** Trusted caller proves no model dispatch. Retains the start; never clears recovered uncertainty. */
  cancelBeforeDispatch(id:string):Promise<void>;
  /** Releases only this view's unreserved half-open claim; durable owner rechecks the ledger. */
  releaseRecoveryAdmission?(): Promise<void>;
  close(): Promise<void>;
}
