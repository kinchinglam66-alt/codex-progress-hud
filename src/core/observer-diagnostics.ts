export const admissionReasons = ['unresolved_previous_call','cooldown','retry_backoff','no_eligible_task','half_open_busy','unsafe_unknown','local_policy'] as const;
export type AdmissionReason = typeof admissionReasons[number];
export function normalizeAdmissionReason(value: unknown): AdmissionReason {
  return admissionReasons.includes(value as AdmissionReason) ? value as AdmissionReason : 'local_policy';
}

export const resultDiagnostics = ['unknown_response','process_error','rejected_result'] as const;
export type ResultDiagnostic = typeof resultDiagnostics[number];
export const resultRejectionReasons = [
  'result_not_accepted',
  'critical_event_after_snapshot',
  'ticket_missing',
  'source_epoch_changed',
  'source_epoch_unavailable',
  'measurement_epoch_changed',
  'measurement_epoch_unavailable',
  'clock_invalid',
  'response_before_request',
  'goal_replaced',
  'epoch_changed',
  'runtime_terminal',
  'source_not_ready',
  'source_revision_changed',
  'source_identity_changed',
  'schema_invalid',
  'prediction_target_mismatch',
  'preparation_failed',
  'aged_response_invalid',
  'aged_response_no_estimate',
  'aged_response_unknown_relation',
  'aged_response_completed',
  'aged_response_not_running',
  'estimate_expired_on_arrival',
  'continue_without_summary',
  'replace_without_pending_relation',
  'completed_runtime_mismatch',
  'scheduler_aborted',
  'scheduler_disabled',
  'scheduler_stale',
  'worker_disabled',
  'worker_stale',
  'worker_unavailable',
  'provider_account_invalid',
  'provider_source_invalid',
  'provider_attachment_invalid',
  'provider_source_closed',
  'provider_source_cancelled',
  'provider_source_identity_mismatch',
  'provider_source_binding_changed',
  'provider_authorization_revoked',
  'provider_interpretation_missing',
] as const;
export type ResultRejectionReason = typeof resultRejectionReasons[number];

/** Preserve only allowlisted source categories, never exception text or paths. */
export function sourceRejectionReason(error:unknown):ResultRejectionReason {
  const code=error!==null&&typeof error==='object'?Reflect.get(error,'code'):undefined;
  switch(code){
    case 'source_closed':return 'provider_source_closed';
    case 'source_cancelled':return 'provider_source_cancelled';
    case 'source_identity_mismatch':return 'provider_source_identity_mismatch';
    case 'SOURCE_HISTORY_BINDING_CHANGED':return 'provider_source_binding_changed';
    default:return error instanceof Error&&error.name==='AbortError'?'provider_source_cancelled':'provider_source_invalid';
  }
}

export const schedulingReasons=['invalid_clock','invalid_counter','context_missing','request_in_flight',
  'no_new_information','no_active_progress','global_concurrency_limit','hourly_limit','runtime_ineligible',
  'initial_delay','cooldown','event_coalescing','adaptive_interval','overdue_already_checked','retry_backoff',
  'observer_disabled','scheduler_exception','accounting_error','setup_failed','recovery_cooldown',
  'worker_unavailable','request_unavailable','account_refresh_failed','worker_closing',
  'worker_cleanup_pending','provider_unavailable','runtime_not_ready'] as const;
export type SchedulingReason=typeof schedulingReasons[number];

/** Fixed codes only: provider exceptions can contain credentials or private paths. */
export function workerAcquisitionReason(error:unknown):SchedulingReason {
  const code=error instanceof Error?error.message:'';
  switch(code){
    case 'OBSERVER_ACCOUNT_REFRESH_FAILED':return 'account_refresh_failed';
    case 'OBSERVER_WORKER_CLOSING':case 'PROVIDER_WORKER_CLOSING':return 'worker_closing';
    case 'OBSERVER_WORKER_CLEANUP_PENDING':return 'worker_cleanup_pending';
    case 'PROVIDER_UNAVAILABLE':return 'provider_unavailable';
    case 'OBSERVER_NOT_READY':return 'runtime_not_ready';
    default:return 'worker_unavailable';
  }
}

export const observerContextStates=['history_loading','context_preparing','context_full','context_compressed',
  'context_native','native_context_failed','source_profile_unsupported','estimate_timeout',
  'context_images_missing',
  'image_context_unsupported',
  'history_incomplete','capacity_unknown','context_too_large','compression_failed'] as const;
export type ObserverContextState=typeof observerContextStates[number];

/** Public static metadata only: never prompt text, account identifiers or provider errors. */
export interface ObserverDiagnostics {
  measurementIdentity?:import('../estimation/prediction-source.js').MeasurementIdentity;
  pendingCriticalEvents?:number;
  reviewIntervalSeconds?:number;
  eventCoalescingRemainingSeconds?:number;
  snapshotEventCutoff?:number;
  schedulerRegistered?:boolean;
  schedulingReason?:SchedulingReason;
  sourceHealth?:'loading'|'ready'|'error'|'missing'|'unavailable';
  missingImages?:number;
  contextState?:ObserverContextState;
  state:'pending'|'history_loading'|'history_unavailable'|'estimating'|'insufficient_context'|'call_failed'|'setup_failed'|'rate_limited'|'admission_blocked'|'disabled'|'ready'|ResultDiagnostic;
  admissionReason?:AdmissionReason;
  resultDiagnostic?:ResultDiagnostic;
  rejectionReason?:ResultRejectionReason;
  estimateAgeSeconds:number|null;
  callsLastHour:number;
  retryPending:boolean;
  stopReason?:'invalid_clock'|'scheduler_exception'|'accounting_error';
  stoppedAt?:number;
}
