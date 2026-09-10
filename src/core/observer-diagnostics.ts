export const admissionReasons = ['unresolved_previous_call','cooldown','retry_backoff','no_eligible_task','half_open_busy','unsafe_unknown','local_policy'] as const;
export type AdmissionReason = typeof admissionReasons[number];
export function normalizeAdmissionReason(value: unknown): AdmissionReason {
  return admissionReasons.includes(value as AdmissionReason) ? value as AdmissionReason : 'local_policy';
}

/** Public static metadata only: never prompt text, account identifiers or provider errors. */
export interface ObserverDiagnostics {
  state:'pending'|'history_loading'|'history_unavailable'|'estimating'|'insufficient_context'|'call_failed'|'setup_failed'|'rate_limited'|'admission_blocked'|'disabled'|'ready';
  admissionReason?:AdmissionReason;
  estimateAgeSeconds:number|null;
  callsLastHour:number;
  retryPending:boolean;
}
