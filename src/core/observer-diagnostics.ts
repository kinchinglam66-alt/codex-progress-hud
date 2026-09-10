/** Public static metadata only: never prompt text, account identifiers or provider errors. */
export interface ObserverDiagnostics {
  state:'pending'|'history_loading'|'history_unavailable'|'estimating'|'insufficient_context'|'call_failed'|'setup_failed'|'rate_limited'|'disabled'|'ready';
  estimateAgeSeconds:number|null;
  callsLastHour:number;
  retryPending:boolean;
}
