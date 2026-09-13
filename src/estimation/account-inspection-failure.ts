export interface AccountInspectionDiagnostic {
  stage:'home-prepare'|'runtime-preflight'|'account-read'|'home-recheck'|'binding'|'ready';
  reason:'timeout'|'cancelled'|'ownership_unconfirmed'|'check_failed';
  attempts:number;
  reader?:Readonly<{reason:'passed'|'login_required'|'timeout'|'cancelled'|'rpc_error'|'read_failed';phase:number}>;
}

/** Safe local metadata only; never attach child stderr, credentials, or RPC payloads. */
export class AccountInspectionFailure extends Error {
  readonly diagnostic: Readonly<AccountInspectionDiagnostic>;
  constructor(diagnostic:AccountInspectionDiagnostic) {
    super('OBSERVER_IDENTITY_UNAVAILABLE');
    this.diagnostic=Object.freeze({...diagnostic});
  }
}
