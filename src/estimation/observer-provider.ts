import type {ObserverResponse} from './observer-contract.js';
import type {OwnedProcessResult} from './owned-process.js';
import type {SubscriptionUsage} from './codex-output.js';
import type {AdmissionKind} from './subscription-accounting.js';

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
  outcomes?: ObserverCallOutcomes;
  timings?: ObserverCallTimings;
}

/** Compatibility result for the subscription-owned session and its ledger.
 * Neutral consumers use ObserverResult so API usage cannot enter subscription
 * accounting through a widened result type. */
export type ObserverSubscriptionResult = Omit<ObserverResult, 'usage'> & {
  usage: SubscriptionUsage | null;
};
