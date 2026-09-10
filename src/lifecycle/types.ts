import { RELEASE_CAPABILITIES } from "../generated/capabilities.js";

export const PROTOCOL_VERSION = RELEASE_CAPABILITIES.protocol.current;
export type DesiredHudState = "on" | "off";
export type ObservedHudState =
  | "starting" | "running" | "hidden" | "stopped"
  | "crashed" | "incompatible" | "port_conflict";

export interface HudSettings {
  desiredState?: DesiredHudState;
  startWithWindows: boolean;
  generation: number;
}

export interface RuntimeIdentity {
  pid: number;
  version: string;
  protocolVersion: number;
  instanceNonce: string;
  startedAt: string;
}

export interface InstallManifest {
  executablePath: string;
  installDirectory: string;
  version: string;
}

export interface StateOperationOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HudCapabilities {
  service: "codex-progress-hud";
  companionVersion: string;
  protocol: { current: number; minimumClient: number; maximumClient: number };
  incompatibleClientSeen: boolean;
}

/**
 * A guarded mutation must stop before starting any irreversible side effect
 * after `signal` aborts, then settle promptly. The state store waits for an
 * entered callback to settle before returning a timeout to its caller.
 */
export type StateMutationOperation<T> = (signal: AbortSignal) => T | Promise<T>;

export interface HudHealth extends RuntimeIdentity {
  windowDiagnostics?: import("../diagnostics/window-state.js").WindowDiagnostics | undefined;
  service: "codex-progress-hud";
  protocolVersion: number;
  visibility: "visible" | "hidden";
  capabilities?: HudCapabilities | undefined;
}

export type HudErrorCode =
  | "COMPANION_NOT_INSTALLED" | "MANUALLY_DISABLED" | "PORT_CONFLICT"
  | "VERSION_MISMATCH" | "START_TIMEOUT" | "AUTH_ERROR"
  | "SHUTDOWN_TIMEOUT" | "COMPANION_CRASHED" | "INTERNAL_ERROR";

export type HudWriteReason = "tracking_start" | "progress_report" | "task_outcome" | "connection";

export interface HudLifecycleSnapshot {
  desiredState?: DesiredHudState;
  observedState: ObservedHudState;
  health?: HudHealth;
  code?: HudErrorCode;
}

export type EnsureResult =
  | { kind: "ready"; generation: number; snapshot: HudLifecycleSnapshot }
  | { kind: "suppressed"; code: "MANUALLY_DISABLED" }
  | { kind: "error"; code: HudErrorCode; snapshot: HudLifecycleSnapshot };

export type DiagnosticReport = { path: string } | { exportStatus: "unavailable"; markdown: string };

export interface LifecycleObservation {
  desiredState?: DesiredHudState;
  starting: boolean;
  identity?: { service: string; protocolVersion: number };
  health?: HudHealth;
  hadHealthyRuntime: boolean;
}

export interface LifecycleStateStore {
  readSettings(options?: StateOperationOptions): Promise<HudSettings>;
  migrateLegacyDesiredState?(options?: StateOperationOptions): Promise<HudSettings>;
  setDesiredState(state: DesiredHudState, options?: StateOperationOptions): Promise<HudSettings>;
  setStartWithWindows(enabled: boolean, options?: StateOperationOptions): Promise<HudSettings>;
  writeRuntime(identity: RuntimeIdentity, generation?: number, options?: StateOperationOptions): Promise<boolean>;
  readRuntime(options?: StateOperationOptions): Promise<RuntimeIdentity | null>;
  clearRuntime(expected?: RuntimeIdentity, options?: StateOperationOptions): Promise<void>;
  clearRuntimeIfGeneration(
    generation: number,
    expected: RuntimeIdentity | null,
    options?: StateOperationOptions
  ): Promise<boolean>;
  readInstallManifest(options?: StateOperationOptions): Promise<InstallManifest | null>;
  runIfGeneration<T>(
    generation: number,
    desiredState: DesiredHudState,
    operation: StateMutationOperation<T>,
    options?: StateOperationOptions
  ): Promise<{ accepted: false } | { accepted: true; value: T }>;
}
