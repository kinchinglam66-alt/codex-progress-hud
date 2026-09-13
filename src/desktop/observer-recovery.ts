import type {AccountedUsage} from '../estimation/subscription-accounting.js';
import type {ObserverSubscriptionResult} from '../estimation/subscription-session.js';
import type {ObserverDiagnostic} from '../estimation/observer-diagnostics.js';
import type {
  ReleaseAccountingRecoveryOwner,
  ReleaseRecoveryPreflight,
  ReleaseRecoveryReason,
  ReleaseRecoveryStatus,
} from '../estimation/release-accounting.js';

export interface RecoveryRuntimeBoundary {
  /** Native/plugin state only. This must not perform inference. */
  enabled(): boolean;
  /** Check ownership, configuration, ledger readability and binding. */
  check(signal: AbortSignal): Promise<{binding: string; closureConfirmed: boolean; reason?: ReleaseRecoveryReason}>;
  /** Runs exactly one fixed synthetic trial through the normal bounded runner. */
  runTrial(reservationId: string, signal: AbortSignal): Promise<RecoveryTrialResult>;
  /** Recreate disabled internal instances after the old owners are closed. */
  rebuild(): Promise<void>;
  /** Release a preflight gate when the user does not continue. */
  release?(): Promise<void>;
  /** Restore the scheduler while the trial-settled ledger still fences dispatch. */
  enable?(): Promise<void>;
}

export interface RecoveryTrialResult {
  usage: AccountedUsage | null; success: boolean; closureConfirmed: boolean;
  /** Internal only. Never spread this object into public settings status. */
  callResult?: ObserverSubscriptionResult;
  diagnostic?: ObserverDiagnostic;
}

export interface RecoveryDiagnostic {
  stage: 'reservation' | 'trial' | 'settlement' | 'rebuild' | 'finish' | 'enable';
  outcome: 'running' | 'failed' | 'success';
  usagePresent: boolean;
  closureConfirmed: boolean;
  callReason?: 'preparation_failed'|'timeout'|'cancelled'|'process_failed'|'invalid_output'|'missing_usage'|'success'|'unknown';
  processReason?: string;
  exitCode?: number | null;
  parserError?: string | null;
  elapsedMs?: number;
  errorCategories?: string[];
}

function copyDiagnostic(value: RecoveryDiagnostic): RecoveryDiagnostic {
  return {...value, ...(value.errorCategories ? {errorCategories: [...value.errorCategories]} : {})};
}

function detailedDiagnostic(value: ObserverDiagnostic): Partial<RecoveryDiagnostic> {
  const reasons=['exited','aborted','disabled','busy','unavailable','timeout','output_limit','spawn_error','stdin_error','cleanup_timeout','protocol_error'];
  const parserCodes=['protocol','encoding','output_limit','unexpected_tool','invalid_prediction','missing_usage'];
  const categories=['http_401','http_403','http_429','tls','connection','unsupported_model','invalid_argument'];
  return {
    processReason: reasons.includes(value.reason) ? value.reason : 'unknown',
    exitCode: Number.isSafeInteger(value.exitCode) ? value.exitCode : null,
    parserError: value.parserError===null ? null : parserCodes.includes(value.parserError) ? value.parserError : 'unknown',
    ...(Number.isSafeInteger(value.elapsedMs)&&value.elapsedMs>=0 ? {elapsedMs:value.elapsedMs} : {}),
    errorCategories: categories.filter(code=>Array.isArray(value.errorCategories)&&value.errorCategories.includes(code)),
  };
}

function callReason(result?: ObserverSubscriptionResult): NonNullable<RecoveryDiagnostic['callReason']> {
  if(!result)return 'unknown';
  const outcome=result.outcomes;
  if(result.status==='aborted'||result.status==='disabled')return 'cancelled';
  if(outcome?.preparationFailed)return 'preparation_failed';
  if(outcome?.processReason==='timeout'||outcome?.call==='timeout')return 'timeout';
  if(outcome?.call!=='success')return 'process_failed';
  if(!outcome.framingValid||outcome.prediction==='invalid')return 'invalid_output';
  if(result.usage===null)return 'missing_usage';
  return result.status==='interpreted'?'success':'unknown';
}
export type ObserverRecoveryControllerStatus = (ReleaseRecoveryStatus | (Omit<ReleaseRecoveryStatus, 'state'> & {state: 'checking' | 'unauthorized' | 'repair_environment'})) & {lastDiagnostic?: RecoveryDiagnostic};

export interface ObserverRecoveryController {
  status(): ObserverRecoveryControllerStatus;
  preflight(): Promise<ReleaseRecoveryPreflight>;
  confirm(revision: number): Promise<ObserverRecoveryControllerStatus>;
  cancel(): Promise<void>;
  disable(): void;
  binding(): string | undefined;
}

export function createObserverRecoveryController(options: {
  accounting: ReleaseAccountingRecoveryOwner;
  runtime: RecoveryRuntimeBoundary;
}): ObserverRecoveryController {
  let override: 'checking' | undefined;
  let binding: string | undefined;
  let currentAttempt: string | undefined;
  let currentReservation: string | undefined;
  let currentAbort: AbortController | undefined;
  let active: Promise<ObserverRecoveryControllerStatus> | undefined;
  let lastDiagnostic: RecoveryDiagnostic | undefined;

  const baseStatus = (): ReleaseRecoveryStatus => options.accounting.recoveryStatus();
  const status = (): ObserverRecoveryControllerStatus => {
    const base = baseStatus();
    return {...base, ...(override === undefined ? {} : {state: override}),
      ...(lastDiagnostic ? {lastDiagnostic: copyDiagnostic(lastDiagnostic)} : {})};
  };
  const requireEnabled = (): void => {
    let enabled = false;
    try { enabled = options.runtime.enabled() === true; } catch { /* fail closed */ }
    if (!enabled) throw new Error('OBSERVER_RECOVERY_DISABLED');
  };
  async function releaseRuntime(): Promise<void> {
    try { await options.runtime.release?.(); } catch { /* Recovery remains closed on release failure. */ }
  }

  async function preflight(): Promise<ReleaseRecoveryPreflight> {
    requireEnabled();
    override = 'checking';
    try {
      const controller = new AbortController();
      const checked = await options.runtime.check(controller.signal);
      if (!checked.closureConfirmed && typeof checked.binding === 'string' && checked.binding.length > 0) {
        const current = baseStatus();
        await releaseRuntime();
        override = undefined;
        return {
          ...current,
          state: 'blocked',
          recoveryAllowed: true,
          allowed: false,
          reason: checked.reason ?? current.reason ?? 'unresolved_previous_call',
        };
      }
      if (!checked.closureConfirmed || typeof checked.binding !== 'string' || checked.binding.length === 0) {
        throw new Error('OBSERVER_RECOVERY_ENVIRONMENT');
      }
      const result = await options.accounting.preflightRecovery(checked.binding);
      binding = checked.binding;
      override = undefined;
      if (!result.allowed) await releaseRuntime();
      return result;
    } catch (error) {
      await releaseRuntime();
      override = undefined;
      throw error instanceof Error ? error : new Error('OBSERVER_RECOVERY_ENVIRONMENT');
    }
  }

  async function runConfirm(revision: number): Promise<ObserverRecoveryControllerStatus> {
    requireEnabled();
    const prepared = binding === undefined ? await preflight() : options.accounting.recoveryStatus();
    if (prepared.revision !== revision || !prepared.recoveryAllowed) throw new Error('OBSERVER_RECOVERY_STALE');
    const checked = await options.runtime.check(new AbortController().signal);
    if (!checked.closureConfirmed || checked.binding !== binding) throw new Error('OBSERVER_RECOVERY_BINDING_CHANGED');
    const confirmation = await options.accounting.confirmRecovery({revision, binding: checked.binding});
    currentAttempt = confirmation.attemptId;
    lastDiagnostic = {stage: 'reservation', outcome: 'running', usagePresent: false, closureConfirmed: false};
    let completed: ObserverRecoveryControllerStatus | undefined;
    try {
      requireEnabled();
      const reservation = await options.accounting.reserveRecoveryTrial(confirmation);
      if (reservation === null) throw new Error('OBSERVER_RECOVERY_BUSY');
      currentReservation = reservation;
      currentAbort = new AbortController();
      lastDiagnostic.stage = 'trial';
      let trial: RecoveryTrialResult;
      try {
        trial = await options.runtime.runTrial(reservation, currentAbort.signal);
      } catch {
        trial = {usage: null, success: false, closureConfirmed: false};
      }
      lastDiagnostic.usagePresent = trial.usage !== null;
      if(trial.diagnostic)Object.assign(lastDiagnostic,detailedDiagnostic(trial.diagnostic));
      lastDiagnostic.callReason = callReason(trial.callResult);
      lastDiagnostic.closureConfirmed = trial.closureConfirmed;
      lastDiagnostic.stage = 'settlement';
      await options.accounting.settleRecoveryTrial(confirmation.attemptId, reservation, trial.usage);
      let success = trial.success && trial.usage !== null && trial.closureConfirmed;
      lastDiagnostic.stage = success ? 'rebuild' : 'trial';
      if (success) {
        try { await options.runtime.rebuild(); }
        catch { success = false; }
      }
      if (success) {
        lastDiagnostic.stage = 'enable';
        try { await options.runtime.enable?.(); requireEnabled(); }
        catch { success = false; }
      }
      const failureStage = lastDiagnostic.stage;
      lastDiagnostic.stage = 'finish';
      await options.accounting.finishRecovery(confirmation.attemptId, {
        success,
        closureConfirmed: trial.closureConfirmed && success,
      });
      if (!success) { lastDiagnostic.stage = failureStage; throw new Error('OBSERVER_RECOVERY_FAILED'); }
      // Do not expose the transient `checking` override to the renderer. The
      // controller cleanup below must complete before the success response is
      // returned, so settings can render the durable recovered/failed state.
      lastDiagnostic.outcome = 'success';
      completed = {...baseStatus(), lastDiagnostic: copyDiagnostic(lastDiagnostic)};
    } catch (error) {
      lastDiagnostic.outcome = 'failed';
      if (currentReservation !== undefined) {
        await options.accounting.cancelRecoveryTrial(confirmation.attemptId, currentReservation).catch(() => undefined);
      } else {
        await options.accounting.cancelRecovery(confirmation.attemptId).catch(() => undefined);
      }
      await releaseRuntime();
      throw error instanceof Error ? error : new Error('OBSERVER_RECOVERY_FAILED');
    } finally {
      currentAttempt = undefined;
      currentReservation = undefined;
      currentAbort = undefined;
      override = undefined;
    }
    if (completed === undefined) throw new Error('OBSERVER_RECOVERY_FAILED');
    return completed;
  }

  return {
    status,
    preflight,
    confirm(revision: number): Promise<ObserverRecoveryControllerStatus> {
      if (active) return active;
      override = 'checking';
      active = runConfirm(revision).finally(() => { active = undefined; });
      return active;
    },
    async cancel(): Promise<void> {
      currentAbort?.abort();
      if (active) await active.catch(() => undefined);
      await releaseRuntime();
    },
    disable(): void {
      currentAbort?.abort();
      override = undefined;
      void releaseRuntime();
    },
    binding(): string | undefined { return binding; },
  };
}
