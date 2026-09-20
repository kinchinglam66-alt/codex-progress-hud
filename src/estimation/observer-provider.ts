import type {ObserverResponse} from './observer-contract.js';
import type {OwnedProcessResult} from './owned-process.js';
import type {SubscriptionUsage} from './codex-output.js';
import type {AdmissionKind} from './subscription-accounting.js';
import type {AdmissionReason,ResultRejectionReason} from '../core/observer-diagnostics.js';

export const observerCallStages = ['admission','preparation','reservation','dispatch','provider_returned','settlement','cleanup','finished'] as const;
export type ObserverCallStage = typeof observerCallStages[number];
/** Diagnostic callbacks cannot authorize, interrupt or retry provider work. */
export function reportObserverStage(listener:((stage:ObserverCallStage)=>void)|undefined, stage:ObserverCallStage):void {
  try {listener?.(stage);} catch { /* Best-effort metadata only. */ }
}

export type ProviderBinding = {
  kind: 'subscription' | 'api';
  profileId: string;
  generation: number;
};

export type ObserverUsage = {
  kind: 'subscription-tokens' | 'api-tokens';
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type ObserverStatus = 'estimated' | 'unavailable' | 'invalid_input' | 'busy' | 'disabled' | 'aborted' |
  'admission_denied' | 'accounting_error' | 'process_error';

export interface ObserverCallOutcomes {
  prediction: 'numeric' | 'unknown' | 'invalid';
  call: 'success' | 'timeout' | 'cancelled' | 'failed';
  usage: 'known' | 'unknown' | 'not_dispatched';
  framingValid: boolean;
  closureConfirmed: boolean;
  dispatch: 'not_started' | 'started' | 'unknown';
  retryable?: 'pre_dispatch_transient';
  preparationFailed?: boolean;
  processReason?: OwnedProcessResult['reason'];
  /** Host-trusted proof that the API reservation reached durable settlement. */
  accounting?: 'durably_settled' | 'pre_dispatch_cancelled';
  failureCode?: 'credential_unavailable' | 'unauthorized' | 'forbidden' | 'rate_limited' |
    'server_error' | 'redirect' | 'network_error' | 'timeout' | 'cancelled' |
    'response_too_large' | 'invalid_response' | 'invalid_output' | 'missing_usage' |
    'accounting_error';
}

export interface ObserverCallTimings {
  preparationMs: number;
  providerMs: number;
  settlementMs: number;
  deliveryMs: number;
  totalMs: number;
}

export interface ObserverResult {
  status: Exclude<ObserverStatus, 'estimated'> | 'interpreted';
  interpretation: ObserverResponse | null;
  usage: ObserverUsage | null;
  admissionKind?: AdmissionKind;
  admissionReason?: AdmissionReason;
  rejectionReason?: ResultRejectionReason;
  outcomes?: ObserverCallOutcomes;
  timings?: ObserverCallTimings;
}

/** Compatibility result for the subscription-owned session and its ledger.
 * Neutral consumers use ObserverResult so API usage cannot enter subscription
 * accounting through a widened result type. */
export type ObserverSubscriptionResult = Omit<ObserverResult, 'usage'> & {
  usage: SubscriptionUsage | null;
};
