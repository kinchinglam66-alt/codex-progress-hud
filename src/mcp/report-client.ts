import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ProgressEnvelope } from "../core/schema.js";
import { RELEASE_CAPABILITIES, acceptsClientProtocol } from "../generated/capabilities.js";
import { hookEnvelopeSchema, type HookEnvelope } from "../hooks/schema.js";
import { type HudCapabilities, PROTOCOL_VERSION, type HudHealth } from "../lifecycle/types.js";
import { windowDiagnosticsSchema } from "../diagnostics/window-state.js";
import type { HudSnapshot } from "../server/task-store.js";
import type { SessionLease } from "../server/lease-store.js";
import { defaultServiceUrl, defaultTokenPath } from "../server/paths.js";
import {admissionReasons,resultDiagnostics,resultRejectionReasons,observerContextStates,schedulingReasons} from '../core/observer-diagnostics.js';

export interface HudRequestOptions {
  timeoutMs?: number;
  generation?: number;
  revision?: number;
  afterRevision?: number;
  clientProtocol?: number;
  signal?: AbortSignal;
  leaseId?: string;
  ownerNonce?: string;
  compatibilityClose?: boolean;
}

interface InternalHudRequestOptions extends HudRequestOptions {
  absoluteDeadlineMs?: number;
}

export interface ProgressClient {
  submit(envelope: ProgressEnvelope, options?: HudRequestOptions): Promise<ProgressClientSnapshot>;
  status(options?: HudRequestOptions): Promise<ProgressClientSnapshot>;
}

interface LegacyProgressClientSnapshot {
  task: { id?: string; title?: string; status: string } | null;
  eta: unknown;
}

export type ProgressClientSnapshot = HudSnapshot | LegacyProgressClientSnapshot;

const HUD_CLIENT_ERROR_CODES = [
  "COMPANION_NOT_INSTALLED", "OFFLINE", "VERSION_MISMATCH", "GENERATION_REJECTED",
  "AUTH_ERROR", "START_TIMEOUT", "REQUEST_TIMEOUT", "REQUEST_CANCELLED",
  "PORT_CONFLICT", "SHUTTING_DOWN", "INTERNAL_ERROR", "STALE_REVISION", "REVISION_REQUIRED",
  "TASK_NOT_FOUND", "LEASE_REQUIRED", "LEASE_FORBIDDEN", "EVENT_NOT_APPLIED"
] as const;
const clientErrorCodeSchema = z.enum(HUD_CLIENT_ERROR_CODES);
const responseErrorCodeSchema = z.enum([
  ...HUD_CLIENT_ERROR_CODES,
  "STALE_REVISION",
  "REVISION_REQUIRED"
] as const);
export type HudClientErrorCode = z.infer<typeof clientErrorCodeSchema>;

export class HudClientError extends Error {
  constructor(readonly code: HudClientErrorCode, message: string) {
    super(message);
    this.name = "HudClientError";
  }
}

const identitySchema = z.object({ service: z.string(), protocolVersion: z.number().int() }).strict();
const capabilitiesSchema = z.object({
  service: z.literal("codex-progress-hud"),
  companionVersion: z.string().trim().min(1).max(256),
  protocol: z.object({
    current: z.number().int().nonnegative(),
    minimumClient: z.number().int().nonnegative(),
    maximumClient: z.number().int().nonnegative()
  }).strict(),
  incompatibleClientSeen: z.boolean()
}).strict();
const healthSchema = z.object({
  service: z.literal("codex-progress-hud"),
  pid: z.number().int().positive(),
  version: z.string().trim().min(1).max(256),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  instanceNonce: z.string().trim().min(1).max(256),
  startedAt: z.string(),
  visibility: z.enum(["visible", "hidden"]),
  windowDiagnostics: windowDiagnosticsSchema.optional().catch(undefined),
  capabilities: capabilitiesSchema.optional()
}).strict();
const controlSchema = z.object({ accepted: z.literal(true) }).strict();

const taskStatusSchema = z.enum([
  "idle", "running", "quiescent", "paused", "stopped", "waiting_approval", "waiting_user",
  "stalled_suspected", "disconnected_suspected", "ended_unknown", "completed_unverified",
  "succeeded_verified", "failed", "interrupted"
]);
const planStepSchema = z.object({
  title: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  weight: z.number().optional()
}).strict();
const taskSnapshotSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  statusDetail: z.string().optional(),
  phase: z.string().optional(),
  currentStep: z.string().optional(),
  progress: z.number().optional(),
  plan: z.array(planStepSchema),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  lastActivityAt: z.number(),
  completedAt: z.number().optional(),
  activeElapsedMs: z.number(),
  activeSince: z.number().optional(),
  modelEstimateSeconds: z.number().optional(),
  modelConfidence: z.number().optional(),
  trackingOrigin: z.enum(["session_start", "late_attach", "manual"]).optional(),
  trackedFrom: z.number().optional(),
  sessionAttachedAt: z.number().optional(),
  turnStartedAt: z.number().optional(),
  turnStoppedAt: z.number().optional(),
  sessionEndedAt: z.number().optional(),
  leaseLostAt: z.number().optional(),
  lastRuntimeEvidenceAt: z.number().optional(),
  estimateVolatility: z.number().optional(),
  verificationEvidence: z.object({
    kind: z.enum(["validation_passed", "validation_failed"]),
    observedAt: z.number()
  }).strict().optional()
}).strict();
const taskSummarySchema = z.object({
  conversationKey: z.string().min(1).max(160).optional(),
  turnKey: z.string().min(1).max(160).optional(),
  isCurrentTurn: z.boolean().optional(),
  id: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  lastActivityAt: z.number(),
  hiddenForTask: z.boolean()
}).strict();
const etaSchema = z.object({
  lowSeconds: z.number(),
  highSeconds: z.number(),
  confidence: z.number(),
  confidenceClass: z.enum(["low", "medium", "high"]),
  signals: z.array(z.enum(["plan", "model", "calibration"]))
}).strict();
const aggregateSnapshotSchema = z.object({
  checkpoint:z.object({state:z.enum(['loading','ready','degraded']),error:z.enum(['read_failed','write_failed']).optional()}).strict().optional(),
  turnTracking: z.object({ identityUnavailable: z.boolean(), orderingUncertain: z.boolean(), capacityReached: z.boolean() }).strict().optional(),
  revision: z.number().int().nonnegative(),
  selectedTaskId: z.string().nullable(),
  selectionMode: z.enum(["follow_activity", "pinned"]),
  tasks: z.array(taskSummarySchema),
  rows: z.array(z.object({
    conversationKey: z.string().min(1).max(160),
    task: taskSnapshotSchema,
    eta: etaSchema.nullable(),
    name: z.object({value:z.string().max(1024).nullable(),freshness:z.enum(['fresh','stale','unavailable'])}).strict(),
    observer:z.object({state:z.enum(['pending','history_loading','history_unavailable','estimating','insufficient_context','call_failed','setup_failed','rate_limited','admission_blocked','disabled','ready',...resultDiagnostics]),
      schedulerRegistered:z.boolean().optional(),sourceHealth:z.enum(['loading','ready','error','missing','unavailable']).optional(),
      schedulingReason:z.enum(schedulingReasons).optional(),
      missingImages:z.number().int().nonnegative().optional(),
      admissionReason:z.enum(admissionReasons).optional(),
      contextState:z.enum(observerContextStates).optional(),
      resultDiagnostic:z.enum(resultDiagnostics).optional(),rejectionReason:z.enum(resultRejectionReasons).optional(),
      stopReason:z.enum(['invalid_clock','scheduler_exception','accounting_error']).optional(),stoppedAt:z.number().int().nonnegative().optional(),
      estimateAgeSeconds:z.number().finite().nonnegative().nullable(),callsLastHour:z.number().int().nonnegative(),retryPending:z.boolean()}).strict().optional(),
    goal: z.object({
      generation: z.number().int().nonnegative(),
      estimateRevision: z.number().int().nonnegative(),
      sampledAtMs: z.number().int().nonnegative(),
      status: z.enum(['running','waiting','paused','interrupted','failed','stopped','completed','unknown']),
      runtime: z.enum(['running','waiting','paused','interrupted','failed','stopped']),
      activeSeconds: z.number().nonnegative(),
      timingUncertain: z.boolean().optional(),
      runtimeUncertain: z.boolean().optional(),
      progressFloor:z.number().finite().min(0).max(99).optional(),
      recoveryState:z.enum(['pending','restored']).optional(),
      recoveryGapSeconds:z.number().finite().min(0).max(31_536_000).nullable().optional(),
      prediction: z.object({remainingSeconds: z.number().nonnegative().max(31536000),
        errorPercent: z.number().nonnegative().max(1000),
        observedActiveSeconds: z.number().nonnegative().max(31536000)}).strict().nullable()
    }).strict().optional()
  }).strict()).max(32).optional(),
  selected: z.object({ task: taskSnapshotSchema, eta: etaSchema.nullable() }).strict().nullable(),
  compatibility: z.object({ incompatibleClientSeen: z.boolean() }).strict(),
  hooks: z.object({
    activitySeen: z.boolean(),
    lastEventAt: z.number().int().nonnegative().optional()
  }).strict().optional(),
  capabilities: capabilitiesSchema.optional()
}).strict();
const legacySnapshotSchema = z.object({
  task: z.object({ id: z.string().optional(), title: z.string().optional(), status: z.string() }).nullable(),
  eta: z.unknown()
}).strict();

// Bounded aggregate: 32 local chat names plus one legacy selected plan.
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_DEADLINE_HEADER = "x-codex-progress-hud-deadline-ms";
const REQUEST_PROTOCOL_HEADER = "x-codex-progress-hud-protocol";
class InvalidResponseError extends Error {}

function boundedTimeoutMs(requestedTimeoutMs: number | undefined): number {
  const bounded = Math.max(
    0,
    Math.min(requestedTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS)
  );
  return Number.isFinite(bounded) ? Math.floor(bounded) : 0;
}

async function readBoundedJson(response: Response, controller: AbortController): Promise<unknown> {
  if (response.status === 204 || response.status === 304) return undefined;
  const reader = response.body?.getReader();
  if (reader === undefined) throw new InvalidResponseError("HUD response body is unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new InvalidResponseError("HUD response exceeds the size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try { return JSON.parse(content); }
  catch { throw new InvalidResponseError("HUD response is not valid JSON"); }
}

export interface HudIdentity {
  service: "codex-progress-hud";
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface LeaseClient {
  acquireLease(ownerNonce: string, ttlMs?: number): Promise<SessionLease>;
  renewLease(lease: SessionLease, ttlMs?: number): Promise<SessionLease>;
  releaseLease(lease: SessionLease): Promise<void>;
  bindLease(taskHandle: string, lease?: SessionLease): Promise<void>;
  setLease(lease: SessionLease | undefined): void;
  setLeaseOwnerNonce(ownerNonce: string): void;
}

export interface MutationLeaseCoordinator {
  start(): Promise<SessionLease>;
  invalidate(expectedLeaseId?: string): void;
}

type TokenReader = (
  path: string,
  options: { encoding: "utf8"; signal: AbortSignal }
) => Promise<string>;

export class CompanionHttpClient implements ProgressClient, LeaseClient {
  #lease: SessionLease | undefined;
  #ownerNonce: string | undefined;
  #leaseCoordinator: MutationLeaseCoordinator | undefined;
  #leaseAcquireFlight: Promise<SessionLease> | undefined;
  constructor(
    private readonly serviceUrl = defaultServiceUrl(),
    private readonly tokenPath = defaultTokenPath(),
    private readonly readToken: TokenReader = (path, options) => readFile(path, options)
  ) {}

  async #token(signal: AbortSignal): Promise<string> {
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error("HUD authentication was cancelled"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return (await Promise.race([
        this.readToken(this.tokenPath, { encoding: "utf8", signal }),
        aborted
      ])).trim();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new HudClientError("AUTH_ERROR", "HUD authentication is unavailable");
    } finally {
      if (abort !== undefined) signal.removeEventListener("abort", abort);
    }
  }

  async #request(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    options: InternalHudRequestOptions
  ): Promise<{ response: Response; payload: unknown }> {
    const controller = new AbortController();
    const deadlineMs = options.absoluteDeadlineMs ?? Date.now() + boundedTimeoutMs(options.timeoutMs);
    const timeoutMs = boundedTimeoutMs(Math.max(0, deadlineMs - Date.now()));
    let abortCause: "deadline" | "external" | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const claimAbortCause = (cause: "deadline" | "external") => {
      if (abortCause === undefined) {
        abortCause = cause;
        controller.abort();
      }
    };
    const abort = () => claimAbortCause("external");
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs === 0) {
      claimAbortCause("deadline");
    } else {
      timer = setTimeout(() => claimAbortCause("deadline"), timeoutMs);
      timer.unref();
    }
    try {
      const query = options.afterRevision === undefined
        ? ""
        : `${path.includes("?") ? "&" : "?"}afterRevision=${encodeURIComponent(String(options.afterRevision))}`;
      const response = await fetch(`${this.serviceUrl}${path}${query}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...init.headers,
          ...(authenticated
            ? {
                authorization: `Bearer ${await this.#token(controller.signal)}`,
                [REQUEST_DEADLINE_HEADER]: String(deadlineMs)
              }
            : {}),
          ...(options.generation === undefined
            ? {}
            : { "x-codex-progress-hud-generation": String(options.generation) }),
          ...(options.revision === undefined
            ? {}
            : { "x-codex-progress-hud-revision": String(options.revision) }),
          ...(init.method?.toUpperCase() === "POST" || (authenticated && path === "/api/snapshot")
            ? {
                [REQUEST_PROTOCOL_HEADER]: String(
                  options.clientProtocol ?? RELEASE_CAPABILITIES.protocol.current
                )
              }
            : {}),
          ...(options.leaseId === undefined || options.ownerNonce === undefined
            ? {}
            : {
                "x-codex-progress-hud-lease": options.leaseId,
                "x-codex-progress-hud-owner": options.ownerNonce
              }),
          ...(options.leaseId !== undefined || options.ownerNonce !== undefined
            ? { "x-codex-progress-hud-client": "mcp" }
            : {}),
          ...(options.compatibilityClose ? { "x-codex-progress-hud-compat-close": "true" } : {})
        }
      });
      return { response, payload: await readBoundedJson(response, controller) };
    } catch (error) {
      if (abortCause === "deadline") {
        throw new HudClientError("REQUEST_TIMEOUT", "Progress HUD request timed out");
      }
      if (abortCause === "external") {
        throw new HudClientError("REQUEST_CANCELLED", "Progress HUD request was cancelled");
      }
      if (error instanceof HudClientError || error instanceof InvalidResponseError) throw error;
      throw new HudClientError("OFFLINE", "Progress HUD is not reachable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async #authenticatedJson(
    path: string,
    init: RequestInit = {},
    options: InternalHudRequestOptions = {}
  ): Promise<unknown> {
    const result = await this.#request(path, init, true, options);
    const structuredCode = z.object({ code: responseErrorCodeSchema })
      .passthrough()
      .safeParse(result.payload);
    if (structuredCode.success) {
      throw new HudClientError(
        structuredCode.data.code as HudClientErrorCode,
        "Progress HUD request was rejected"
      );
    }
    if (result.response.status === 401) {
      throw new HudClientError("AUTH_ERROR", "HUD authentication was rejected");
    }
    if (result.response.status === 409) {
      throw new HudClientError("GENERATION_REJECTED", "HUD lifecycle generation was rejected");
    }
    if (result.response.status === 423) {
      throw new HudClientError("SHUTTING_DOWN", "Progress HUD is shutting down");
    }
    if (result.response.status === 408) {
      throw new HudClientError("REQUEST_TIMEOUT", "Progress HUD request timed out");
    }
    if (!result.response.ok) {
      throw new HudClientError("INTERNAL_ERROR", "HUD endpoint returned an unexpected error");
    }
    return result.payload;
  }

  #effectiveOptions(options: InternalHudRequestOptions = {}): InternalHudRequestOptions {
    return {
      ...options,
      ...(options.leaseId === undefined && this.#ownerNonce !== undefined
        ? { leaseId: this.#lease?.id ?? "", ownerNonce: this.#lease?.ownerNonce ?? this.#ownerNonce }
        : {})
    };
  }

  #withAbsoluteDeadline(options: InternalHudRequestOptions): InternalHudRequestOptions {
    return options.absoluteDeadlineMs === undefined
      ? { ...options, absoluteDeadlineMs: Date.now() + boundedTimeoutMs(options.timeoutMs) }
      : options;
  }

  async #ensureLeaseForMutation(): Promise<void> {
    if (this.#ownerNonce === undefined || this.#lease !== undefined) return;
    if (this.#leaseAcquireFlight !== undefined) {
      await this.#leaseAcquireFlight;
      return;
    }
    const flight = this.#leaseCoordinator?.start() ?? this.acquireLease(this.#ownerNonce);
    this.#leaseAcquireFlight = flight;
    try {
      const acquired = await flight;
      if (this.#lease === undefined) this.setLease(acquired);
    } finally {
      if (this.#leaseAcquireFlight === flight) this.#leaseAcquireFlight = undefined;
    }
  }

  #invalidateLease(expectedLeaseId: string | undefined): void {
    if (expectedLeaseId !== undefined && this.#lease?.id !== expectedLeaseId) return;
    this.#lease = undefined;
    this.#leaseCoordinator?.invalidate(expectedLeaseId);
  }

  async acquireLease(ownerNonce: string, ttlMs?: number): Promise<SessionLease> {
    const payload = await this.#authenticatedJson("/api/leases/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerNonce, ...(ttlMs === undefined ? {} : { ttlMs }) })
    });
    return z.object({ id: z.string(), ownerNonce: z.string(), expiresAt: z.number().int() }).strict().parse(payload);
  }

  async renewLease(lease: SessionLease, ttlMs?: number): Promise<SessionLease> {
    const payload = await this.#authenticatedJson("/api/leases/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: lease.id, ownerNonce: lease.ownerNonce, ...(ttlMs === undefined ? {} : { ttlMs }) })
    }, leaseOptions(lease));
    return z.object({ id: z.string(), ownerNonce: z.string(), expiresAt: z.number().int() }).strict().parse(payload);
  }

  async releaseLease(lease: SessionLease): Promise<void> {
    await this.#authenticatedJson("/api/leases/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: lease.id, ownerNonce: lease.ownerNonce })
    }, leaseOptions(lease));
  }

  async bindLease(taskHandle: string, lease = this.#lease): Promise<void> {
    if (lease === undefined) throw new HudClientError("LEASE_REQUIRED", "MCP lease is not acquired");
    await this.#authenticatedJson("/api/leases/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: lease.id, ownerNonce: lease.ownerNonce, taskHandle })
    }, leaseOptions(lease));
  }

  setLease(lease: SessionLease | undefined): void {
    this.#lease = lease;
  }

  currentLease(): SessionLease | undefined {
    return this.#lease === undefined ? undefined : { ...this.#lease };
  }

  setLeaseOwnerNonce(ownerNonce: string): void {
    this.#ownerNonce = ownerNonce;
  }

  setLeaseCoordinator(coordinator: MutationLeaseCoordinator): void {
    this.#leaseCoordinator = coordinator;
  }

  async identity(options: HudRequestOptions = {}): Promise<HudIdentity> {
    let result: { response: Response; payload: unknown };
    try { result = await this.#request("/health", {}, false, options); }
    catch (error) {
      if (error instanceof HudClientError) throw error;
      throw new HudClientError("PORT_CONFLICT", "Listener is not the Progress HUD service");
    }
    if (!result.response.ok) {
      throw new HudClientError("PORT_CONFLICT", "Listener is not the Progress HUD service");
    }
    let parsed: z.infer<typeof identitySchema>;
    try { parsed = identitySchema.parse(result.payload); }
    catch { throw new HudClientError("PORT_CONFLICT", "Listener is not the Progress HUD service"); }
    if (parsed.service !== "codex-progress-hud") {
      throw new HudClientError("PORT_CONFLICT", "Listener is not the Progress HUD service");
    }
    if (!acceptsClientProtocol(parsed.protocolVersion)) {
      throw new HudClientError("VERSION_MISMATCH", "Progress HUD protocol is incompatible");
    }
    return { service: parsed.service, protocolVersion: PROTOCOL_VERSION };
  }

  async health(options: HudRequestOptions = {}): Promise<HudHealth> {
    try {
      const health = healthSchema.parse(await this.#authenticatedJson("/api/health", { headers: { "x-hud-window-diagnostics": "1" } }, options));
      const capabilities = health.capabilities as HudCapabilities | undefined;
      if (capabilities !== undefined && (
        RELEASE_CAPABILITIES.protocol.current < capabilities.protocol.minimumClient ||
        RELEASE_CAPABILITIES.protocol.current > capabilities.protocol.maximumClient
      )) {
        throw new HudClientError("VERSION_MISMATCH", "Progress HUD protocol is incompatible");
      }
      const { capabilities: _capabilities, ...runtimeHealth } = health;
      return runtimeHealth;
    }
    catch (error) {
      if (error instanceof HudClientError) throw error;
      throw new HudClientError("VERSION_MISMATCH", "Progress HUD health response is incompatible");
    }
  }

  async #control(path: string, options: HudRequestOptions = {}): Promise<void> {
    try {
      controlSchema.parse(await this.#authenticatedJson(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }, options));
    } catch (error) {
      if (error instanceof HudClientError) throw error;
      throw new HudClientError("VERSION_MISMATCH", "HUD control response is incompatible");
    }
  }

  show(options?: HudRequestOptions): Promise<void> { return this.#control("/api/window/show", options); }
  hide(options?: HudRequestOptions): Promise<void> { return this.#control("/api/window/hide", options); }
  shutdown(options?: HudRequestOptions): Promise<void> { return this.#control("/api/shutdown", options); }

  #parseSnapshot(payload: unknown): HudSnapshot {
    const aggregate = aggregateSnapshotSchema.safeParse(payload);
    if (aggregate.success) return aggregate.data as HudSnapshot;
    const legacy = legacySnapshotSchema.safeParse(payload);
    if (legacy.success) return legacy.data as unknown as HudSnapshot;
    throw new HudClientError("VERSION_MISMATCH", "HUD snapshot response is incompatible");
  }

  async #snapshot(path: string, init: RequestInit = {}, options: InternalHudRequestOptions = {}): Promise<HudSnapshot> {
    return this.#parseSnapshot(await this.#authenticatedJson(path, init, options));
  }

  async submit(envelope: ProgressEnvelope, options?: HudRequestOptions): Promise<HudSnapshot> {
    const explicitLease = options?.leaseId !== undefined || options?.ownerNonce !== undefined;
    if (!explicitLease) await this.#ensureLeaseForMutation();
    const request = (requestOptions: HudRequestOptions) => this.#snapshot("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope)
    }, requestOptions);
    const firstOptions = this.#withAbsoluteDeadline(this.#effectiveOptions(options));
    try {
      return await request(firstOptions);
    } catch (error) {
      if (
        !(error instanceof HudClientError) || error.code !== "LEASE_REQUIRED" ||
        this.#ownerNonce === undefined || explicitLease
      ) {
        throw error;
      }
      this.#invalidateLease(firstOptions.leaseId);
      await this.#ensureLeaseForMutation();
      const retryOptions = { ...firstOptions };
      delete retryOptions.leaseId;
      delete retryOptions.ownerNonce;
      return request(this.#effectiveOptions(retryOptions));
    }
  }

  submitHook(envelope: HookEnvelope, options?: HudRequestOptions): Promise<HudSnapshot> {
    hookEnvelopeSchema.parse(envelope);
    return this.#snapshot("/api/hooks/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope)
    }, this.#effectiveOptions(options));
  }

  selectTask(
    taskId: string,
    mode: "pinned" | "follow_activity",
    options?: HudRequestOptions
  ): Promise<HudSnapshot> {
    return this.#snapshot(`/api/tasks/${encodeURIComponent(taskId)}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode })
    }, this.#effectiveOptions(options));
  }

  setTaskVisibility(
    taskId: string,
    hidden: boolean,
    options?: HudRequestOptions
  ): Promise<HudSnapshot> {
    return this.#snapshot(`/api/tasks/${encodeURIComponent(taskId)}/visibility`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden })
    }, this.#effectiveOptions(options));
  }

  status(options: HudRequestOptions & { afterRevision: number }): Promise<HudSnapshot | null>;
  status(options?: HudRequestOptions): Promise<HudSnapshot>;
  async status(options: HudRequestOptions = {}): Promise<HudSnapshot | null> {
    const payload = await this.#authenticatedJson("/api/snapshot", {}, this.#effectiveOptions(options));
    if (payload === undefined && options.afterRevision !== undefined) return null;
    return this.#parseSnapshot(payload);
  }
}

function leaseOptions(lease: SessionLease): HudRequestOptions {
  return { leaseId: lease.id, ownerNonce: lease.ownerNonce };
}

export { CompanionHttpClient as HttpProgressClient };
