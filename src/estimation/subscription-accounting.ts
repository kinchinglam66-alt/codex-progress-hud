/** Execution-facing accounting contract. Implementations own durable admission.
 * Null settlement means unknown usage, never a free or unlaunched call.
 */
export interface AccountedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
}

export type AdmissionKind = 'ordinary' | 'retry' | 'half_open';
export type SettlementClassification = 'known_success' | 'known_non_success' | 'safe_unknown' | 'unsafe_unknown';

export interface SubscriptionAccounting {
  reserve(admissionKind?: AdmissionKind): Promise<string | null>;
  settle(id: string, usage: AccountedUsage | null, classification?: SettlementClassification): Promise<void>;
  /** Trusted caller proves no model dispatch. Retains the start; never clears recovered uncertainty. */
  cancelBeforeDispatch(id:string):Promise<void>;
  /** Releases only this view's unreserved half-open claim; durable owner rechecks the ledger. */
  releaseRecoveryAdmission?(): Promise<void>;
  close(): Promise<void>;
}
