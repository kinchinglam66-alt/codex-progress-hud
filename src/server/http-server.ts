import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z, ZodError } from "zod";
import { readWindowDiagnostics } from "../diagnostics/window-state.js";
import { type ProgressEnvelope } from "../core/schema.js";
import {controlEnvelopeSchema} from './control-schema.js';
import { RELEASE_CAPABILITIES, acceptsClientProtocol } from "../generated/capabilities.js";
import { parseHookEnvelope, normalizeHookInput, type HookEnvelope } from "../hooks/schema.js";

export type ObserverHookEvent = 'prompt'|'activity'|'final'|'failure';

export function observerEventForHook(envelope: Pick<HookEnvelope, 'hook'|'toolExitCode'|'toolFailure'>): ObserverHookEvent {
  if (envelope.hook === 'UserPromptSubmit') return 'prompt';
  if (envelope.hook === 'Stop') return 'final';
  // An exit code alone may mean e.g. grep/rg found no matches, not failed work.
  if (envelope.hook === 'PostToolUse' && envelope.toolFailure===true) return 'failure';
  return 'activity';
}
import { PROTOCOL_VERSION, type HudCapabilities, type HudHealth } from "../lifecycle/types.js";
import type { DesiredHudState } from "../lifecycle/types.js";
import { loadOrCreateToken, tokensEqual } from "./token-store.js";
import { TaskStore, type HudSnapshot } from "./task-store.js";
import { LeaseStore } from "./lease-store.js";
import { createTurnRouter } from "./turn-router.js";
import { terminalEventBlocked } from "../core/reducer.js";
import { createHmac } from 'node:crypto';
import { createConversationNames } from './conversation-names.js';
import { PassiveContextStore } from './passive-context-store.js';
import { PassiveGoals, createProductionPassiveGoals } from './passive-goals.js';
import { ObserverScheduler, type ObserverWorker, type ObserverWorkerSource, type ObserverObservation } from '../estimation/observer-scheduler.js';
import {parseEstimateTimeoutMs} from '../estimation/request-timeout.js';
import {ScopedSnapshots} from './scoped-snapshots.js';
import {createLocalSessionReader} from '../observer/local-session-reader.js';
import {createSessionStartRecovery} from '../observer/session-start-recovery.js';
import {createConversationSource} from '../observer/conversation-source.js';
import {createGoalCheckpointRepository,type GoalCheckpointRepository} from './goal-checkpoint.js';
import {createMilestoneCheckpointRepository} from './milestone-checkpoint.js';

const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_DEADLINE_HEADER = "x-codex-progress-hud-deadline-ms";
const REQUEST_PROTOCOL_HEADER = "x-codex-progress-hud-protocol";
const REQUEST_REVISION_HEADER = "x-codex-progress-hud-revision";
const REQUEST_GENERATION_HEADER = "x-codex-progress-hud-generation";
const MAX_REQUEST_DEADLINE_AHEAD_MS = 60_000;
const MAX_REMEMBERED_HOOK_IDS = 4_096;
const LEASE_HEADER = "x-codex-progress-hud-lease";
const OWNER_HEADER = "x-codex-progress-hud-owner";
const MCP_CLIENT_HEADER = "x-codex-progress-hud-client";
const COMPATIBILITY_CLOSE_HEADER = "x-codex-progress-hud-compat-close";
const DEFAULT_LEASE_GRACE_MS = 45_000;

type TaskLeaseDecision = "accepted" | "lease_required" | "lease_forbidden";

const selectionRequestSchema = z.object({
  mode: z.enum(["pinned", "follow_activity"])
}).strict();
const visibilityRequestSchema = z.object({ hidden: z.boolean() }).strict();
const leaseAcquireSchema = z.object({
  ownerNonce: z.string().trim().min(1).max(256),
  ttlMs: z.number().finite().nonnegative().optional()
}).strict();
const leaseMutationSchema = z.object({
  id: z.string().regex(/^lease_[A-Za-z0-9_-]{8,256}$/u),
  ownerNonce: z.string().trim().min(1).max(256),
  ttlMs: z.number().finite().nonnegative().optional()
}).strict();
const leaseBindSchema = leaseMutationSchema.omit({ ttlMs: true }).extend({
  taskHandle: z.string().regex(/^hud_[A-Za-z0-9_-]{20,96}$/u)
}).strict();

export interface ProgressServerControls {
  health(): HudHealth;
  showWindow(): void | Promise<void>;
  hideWindow(): void | Promise<void>;
  openSettings?(): void | Promise<void>;
  requestShutdown(): void | Promise<void>;
}

export interface ProgressServerBootstrap {
  protocolVersion: number;
  generation: number;
}

export interface ProgressServerOptions extends Partial<ProgressServerControls> {
  host?: string;
  port?: number;
  tokenPath: string;
  uiDirectory?: string;
  leaseStore?: LeaseStore;
  leaseGraceMs?: number;
  awaitInitialLease?: boolean;
  bootstrap?: () => ProgressServerBootstrap;
  now?: () => number;
  /** Independent active-work/scheduling clock; never a host event timestamp. */
  monotonicNow?: () => number;
  scheduleTimer?: (callback: () => void, delayMs: number) => unknown;
  cancelTimer?: (handle: unknown) => void;
  readConversationName?: (hostId: string, signal: AbortSignal) => Promise<string | null>;
  closeConversationNames?: () => Promise<void>;
  /** Private in-process owner shared with the observer, never exposed over HTTP. */
  passiveContexts?: PassiveContextStore;
  passiveGoals?: PassiveGoals;
  goalCheckpointRepository?: GoalCheckpointRepository;
  /** Exclusive companion instance AND generation proof, not renderer input. */
  isGoalCheckpointOwner?: ()=>Promise<boolean>;
  /** Owned, authorized workers only. Omission leaves live observation unconfigured. */
  observerWorkers?: readonly ObserverWorker[];
  observerWorkerSource?: ObserverWorkerSource;
  observerSchedulerRecovery?: {attachScheduler(scheduler: Pick<ObserverScheduler, 'prepareRecovery' | 'restoreRecovery'>): void};
  /** Explicit selected local source; omission preserves the legacy test adapter. */
  observerSessionsRoot?:string;
  onObserverObservation?: (record:ObserverObservation)=>void;
  residualResearch?:import('../estimation/residual/runtime.js').ResidualRuntime;
  runIfGeneration?(
    generation: number,
    desiredState: DesiredHudState,
    operation: (signal: AbortSignal) => unknown | Promise<unknown>,
    signal: AbortSignal
  ): Promise<{ accepted: false } | { accepted: true; value: unknown }>;
}

export interface ProgressServerAddress {
  host: string;
  port: number;
  url: string;
}

class BodyTooLargeError extends Error {}
class RequestDeadlineExpiredError extends Error {}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function requestDeadline(request: IncomingMessage): number | undefined {
  const header = request.headers[REQUEST_DEADLINE_HEADER];
  if (typeof header !== "string" || !/^(?:0|[1-9]\d*)$/u.test(header)) return undefined;
  const deadline = Number(header);
  if (!Number.isSafeInteger(deadline)) return undefined;
  return deadline - Date.now() <= MAX_REQUEST_DEADLINE_AHEAD_MS ? deadline : undefined;
}

function requestCancellation(
  request: IncomingMessage,
  response: ServerResponse
): { signal: AbortSignal; complete(): void; dispose(): void } {
  const controller = new AbortController();
  const socket = request.socket;
  const deadline = requestDeadline(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  const cancel = (reason?: unknown) => {
    if (!completed && !controller.signal.aborted) controller.abort(reason);
  };
  const cancelDisconnected = () => cancel();
  const dispose = () => {
    request.removeListener("aborted", cancelDisconnected);
    response.removeListener("close", cancelDisconnected);
    socket.removeListener("close", cancelDisconnected);
    if (timer !== undefined) clearTimeout(timer);
  };
  request.once("aborted", cancelDisconnected);
  response.once("close", cancelDisconnected);
  socket.once("close", cancelDisconnected);
  if (deadline !== undefined) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      cancel(new RequestDeadlineExpiredError("HUD request deadline expired"));
    } else {
      timer = setTimeout(
        () => cancel(new RequestDeadlineExpiredError("HUD request deadline expired")),
        remainingMs
      );
      timer.unref();
    }
  }
  return {
    signal: controller.signal,
    complete() {
      completed = true;
      dispose();
    },
    dispose
  };
}

async function serveUi(
  response: ServerResponse,
  uiDirectory: string,
  pathname: string
): Promise<boolean> {
  const assets: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/renderer.js": { file: "renderer.js", type: "text/javascript; charset=utf-8" },
    "/conversation-renderer.js": { file: "conversation-renderer.js", type: "text/javascript; charset=utf-8" },
    "/view-model.js": { file: "view-model.js", type: "text/javascript; charset=utf-8" },
    "/display-clock.js": { file: "display-clock.js", type: "text/javascript; charset=utf-8" },
    "/eta-transition.js": { file: "eta-transition.js", type: "text/javascript; charset=utf-8" },
    "/eta-clock-policy.js": { file: "eta-clock-policy.js", type: "text/javascript; charset=utf-8" },
    "/core/eta-time-basis.js": { file: "../core/eta-time-basis.js", type: "text/javascript; charset=utf-8" },
    "/countdown.js": { file: "countdown.js", type: "text/javascript; charset=utf-8" },
    "/core/observer-diagnostics.js": { file: "../core/observer-diagnostics.js", type: "text/javascript; charset=utf-8" },
    "/task-mutations.js": { file: "task-mutations.js", type: "text/javascript; charset=utf-8" },
    "/task-controls.js": { file: "task-controls.js", type: "text/javascript; charset=utf-8" }
  };
  const asset = assets[pathname];
  if (asset === undefined) return false;
  try {
    const content = await readFile(join(uiDirectory, asset.file));
    response.writeHead(200, {
      "content-type": asset.type,
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    });
    response.end(content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError("request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readEmptyJson(request: IncomingMessage): Promise<void> {
  const payload = await readJson(request);
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 0
  ) {
    throw new SyntaxError("control payload must be an empty JSON object");
  }
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function hasJsonMediaType(request: IncomingMessage): boolean {
  const mediaType = (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim();
  return mediaType?.toLowerCase() === "application/json";
}

function isMcpRequest(request: IncomingMessage): boolean {
  return request.headers[MCP_CLIENT_HEADER] === "mcp";
}

function leaseCredentials(request: IncomingMessage): { id: string; ownerNonce: string } | undefined {
  const id = request.headers[LEASE_HEADER];
  const ownerNonce = request.headers[OWNER_HEADER];
  return typeof id === "string" && typeof ownerNonce === "string"
    ? { id, ownerNonce }
    : undefined;
}

function requestNonnegativeInteger(request: IncomingMessage, headerName: string): number | undefined {
  const header = request.headers[headerName];
  if (typeof header !== "string" || !/^(?:0|[1-9]\d*)$/u.test(header)) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : undefined;
}

function requestRevision(request: IncomingMessage): number | undefined {
  return requestNonnegativeInteger(request, REQUEST_REVISION_HEADER);
}

function taskRoute(pathname: string): { taskId: string; action: "select" | "visibility" } | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/(select|visibility)$/u.exec(pathname);
  if (match === null) return undefined;
  let taskId: string;
  try {
    taskId = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId)) return undefined;
  return { taskId, action: match[2] as "select" | "visibility" };
}

function unsafeTaskRequestTarget(rawUrl: string): boolean {
  const rawPath = rawUrl.split("?", 1)[0] ?? rawUrl;
  if (!rawPath.startsWith("/api/tasks/")) return false;
  for (const segment of rawPath.split("/").slice(3)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      return true;
    }
  }
  return false;
}

function eventRequiresExistingTask(event: ProgressEnvelope["event"]): boolean {
  return event.type !== "tracking_started" && event.type !== "model_progress" &&
    event.type !== "waiting";
}

function afterRevision(url: URL): number | undefined {
  const value = url.searchParams.get("afterRevision");
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new SyntaxError("invalid afterRevision");
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new SyntaxError("invalid afterRevision");
  return revision;
}

export function createProgressServer(options: ProgressServerOptions) {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 17_837;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Codex Progress HUD only permits loopback listeners");
  }

  const now = options.now ?? Date.now;
  const goalNow = options.monotonicNow ?? (() => Math.floor(performance.now()));
  const names = createConversationNames(options.readConversationName ?? (async () => null), {
    now, onChange: () => { if(!shuttingDown) store.refreshPresentation(); }
  });
  const turnRouter = createTurnRouter();
  const passiveContexts = options.passiveContexts ?? new PassiveContextStore();
  if(options.observerSessionsRoot!==undefined&&options.passiveGoals!==undefined)throw Error('CONFLICTING_OBSERVER_SOURCE');
  let sourceToken:string|undefined;
  const workerSource = options.observerWorkerSource;
  const sessionReader=options.observerSessionsRoot===undefined||(options.observerWorkers===undefined&&workerSource===undefined)?undefined:
    createLocalSessionReader({root:options.observerSessionsRoot});
  const selectedSource=sessionReader===undefined?undefined:
    createConversationSource({source:sessionReader,now:goalNow,wallNow:now,
      turnKeyFor:(hostId,turnId)=>{
        if(sourceToken===undefined)throw Error('SOURCE_IDENTITY_UNAVAILABLE');
        return `turn_${createHmac('sha256',sourceToken).update(`${hostId}\u0000${turnId}`).digest('base64url')}`;
      },taskHandleFor:(hostId,turnId)=>{
        if(sourceToken===undefined)throw Error('SOURCE_IDENTITY_UNAVAILABLE');
        return `hud_${createHmac('sha256',sourceToken).update(`turn-task\u0000${hostId}\u0000${turnId}`).digest('base64url')}`;
      },onChange:key=>{if(!shuttingDown){
        const takeover=passiveGoals.reconcileSource(key,goalNow());
        if(takeover?.taskHandle!==undefined){
          if(takeover.previousTurnKey!==undefined){
            turnRouter.takeover(key,takeover.previousTurnKey,takeover.turnKey,takeover.taskHandle,now());
          }
          store.apply({taskId:takeover.taskHandle,event:{type:'session_attached',origin:'late_attach'}},now(),
            {conversationKey:key,turnKey:takeover.turnKey,isCurrentTurn:true});
        }
        passiveObserver?.changed(key,takeover===null?'activity':'prompt');store.refreshPresentation();
      }}});
  const passiveGoals = options.passiveGoals ?? createProductionPassiveGoals(passiveContexts,selectedSource?.goals,
    options.residualResearch?event=>options.residualResearch!.boundary(event):undefined);
  const sessionRecovery=sessionReader===undefined?undefined:createSessionStartRecovery({now:goalNow,wallNow:now,
    discover:(hostId,signal)=>sessionReader.discoverRunningTurn(hostId,signal),
    activate:async(key,hostId,result,generation,signal)=>{
      const activate=async(authorizedSignal:AbortSignal)=>{
        if(shuttingDown||authorizedSignal.aborted||signal.aborted||sourceToken===undefined||passiveGoals.currentTurnKey(key)!==undefined)return;
        const envelope=normalizeHookInput('PostToolUse',{session_id:hostId,turn_id:result.turnId},now(),sourceToken).envelope;
        const at=goalNow();
        if(envelope.sessionKey!==key||!store.canAdmit(envelope.taskHandle)||
          !turnRouter.canLateAttach(envelope)||!passiveGoals.canAdmitRecovery(key,at))return;
        // Reserve the fallible source before publishing any router/task identity.
        try{selectedSource?.attach(key,hostId,envelope.turnKey!);}
        catch{selectedSource?.remove(key);return;}
        passiveGoals.observe({...envelope,receivedAt:at},true,at);
        if(passiveGoals.currentTurnKey(key)!==envelope.turnKey){selectedSource?.remove(key);return;}
        const route=turnRouter.route(envelope,now());
        if(route.kind!=='apply'||!route.follow){passiveGoals.end(key);selectedSource?.remove(key);return;}
        store.apply({taskId:envelope.taskHandle,event:{type:'session_attached',origin:'late_attach'}},now(),
          {conversationKey:key,turnKey:route.turnKey,isCurrentTurn:true});
        if(names.register(key,hostId)){knownConversations.add(key);refreshNames();}
        passiveObserver?.changed(key,'prompt');store.refreshPresentation();
      };
      if(options.runIfGeneration){if(generation!==undefined)await options.runIfGeneration(generation,'on',activate,signal);}
      else await activate(signal);
    }});
  const pruneSources=()=>{
    const at=passiveObserver?.presentationTime() ?? goalNow();selectedSource?.prune(key=>{
      const retain=passiveGoals.retainSource(key,at);if(!retain)try{options.residualResearch?.forget(key);}catch{}return retain;
    });
  };
  const store = new TaskStore({ now, nameForConversation: key => names.get(key),
    goalForConversation: key => passiveGoals.view(key, passiveObserver?.presentationTime() ?? goalNow()),
    observerForConversation:key=>passiveObserver?.diagnostics(key) });
  const scopedSnapshots = new ScopedSnapshots(store);
  const passiveObserver = options.observerWorkers === undefined && workerSource === undefined ? undefined : new ObserverScheduler({
    requestTimeoutMs:parseEstimateTimeoutMs(process.env.CODEX_PROGRESS_HUD_ESTIMATE_TIMEOUT_MS),
    contexts: passiveContexts, goals: passiveGoals, ...(workerSource ? {workerSource} : {workers: options.observerWorkers!}), now: goalNow,
    ...(options.onObserverObservation?{onObservation:options.onObserverObservation}:{}),
    ...(options.residualResearch?{research:options.residualResearch}:{}),
    onChange: () => {if (!shuttingDown) {pruneSources();store.refreshPresentation();}}
  });
  if (passiveObserver !== undefined) options.observerSchedulerRecovery?.attachScheduler(passiveObserver);
  let observerTimer: ReturnType<typeof setInterval>|undefined;
  let sourceTimer:ReturnType<typeof setInterval>|undefined;
  const leaseStore = options.leaseStore ?? new LeaseStore();
  const leaseGraceMs = options.leaseGraceMs ?? DEFAULT_LEASE_GRACE_MS;
  if (!Number.isSafeInteger(leaseGraceMs) || leaseGraceMs < 30_000 || leaseGraceMs > 60_000) {
    throw new RangeError("leaseGraceMs must be an integer between 30000 and 60000");
  }
  const tokenPromise = loadOrCreateToken(options.tokenPath).then(token=>{sourceToken=token;return token;});
  let server: Server | undefined;
  let currentAddress: ProgressServerAddress | undefined;
  let shuttingDown = false;
  let checkpointRepository=options.goalCheckpointRepository;
  let milestoneRepository:ReturnType<typeof createMilestoneCheckpointRepository>|undefined;
  let milestonePending:ReturnType<PassiveGoals['milestoneCheckpoint']>=[];
  let checkpointReady=false;
  let checkpointState:'disabled'|'loading'|'ready'|'degraded'='disabled';
  let checkpointTimer:ReturnType<typeof setTimeout>|undefined;
  let checkpointInterval:ReturnType<typeof setInterval>|undefined;
  let checkpointTail:Promise<void>=Promise.resolve();
  let checkpointWriting=false;
  let checkpointPending:ReturnType<PassiveGoals['checkpoint']>|undefined;
  let checkpointError:'read_failed'|'write_failed'|undefined;
  const checkpointStatus=(state:typeof checkpointState,error?:typeof checkpointError)=>{
    const changed=checkpointState!==state||checkpointError!==error;
    checkpointState=state;checkpointError=error;
    if(changed&&!shuttingDown)store.refreshPresentation();
  };
  const saveCheckpoint=():Promise<void>=>{
    if(!checkpointReady||!checkpointRepository)return checkpointTail;
    let records:ReturnType<PassiveGoals['checkpoint']>;
    try{records=passiveGoals.checkpoint(goalNow(),now());}
    catch{checkpointStatus('degraded','write_failed');return checkpointTail;}
    const repository=checkpointRepository;
    // At most one write and one latest snapshot: slow storage cannot grow a backlog.
    checkpointPending=records;
    milestonePending=passiveGoals.milestoneCheckpoint(now());
    if(checkpointWriting)return checkpointTail;
    checkpointWriting=true;
    checkpointTail=Promise.resolve().then(async()=>{
      try{
        while(checkpointPending!==undefined){
          const next=checkpointPending;checkpointPending=undefined;
          const nextMilestones=milestonePending;
          try{await repository.save(next);await milestoneRepository?.save(nextMilestones);checkpointStatus('ready');}
          catch{checkpointStatus('degraded','write_failed');}
        }
      }finally{checkpointWriting=false;}
    });
    return checkpointTail;
  };
  const scheduleCheckpoint=()=>{
    if(shuttingDown||!checkpointReady||!checkpointRepository||checkpointTimer!==undefined)return;
    checkpointTimer=setTimeout(()=>{checkpointTimer=undefined;void saveCheckpoint();},1000);
    checkpointTimer.unref();
  };
  store.on('changed',scheduleCheckpoint);
  let graceTimer: unknown;
  let graceHandles = new Set<string>();
  const leaseSweepTimer = setInterval(() => leaseStore.sweep(), 1_000);
  leaseSweepTimer.unref();
  const hookEventIds = new Set<string>();
  const hookEventOrder: string[] = [];
  let lastHookEventAt: number | undefined;
  const knownConversations = new Set<string>();
  const refreshNames = () => {
    if(shuttingDown) return;
    const active = new Set(store.conversationRows().map(row => row.conversationKey));
    for(const key of knownConversations) {
      if(!store.snapshot().tasks.some(task => task.conversationKey === key && task.isCurrentTurn)) {
        names.forget(key); knownConversations.delete(key);
      } else if(active.has(key)) { void names.refresh(key); }
    }
  };
  const nameTimer = setInterval(refreshNames,10000);
  nameTimer.unref();
  store.on('changed',refreshNames);
  function capabilities(health: HudHealth): HudCapabilities {
    return {
      service: "codex-progress-hud",
      companionVersion: health.version,
      protocol: RELEASE_CAPABILITIES.protocol,
      incompatibleClientSeen: store.snapshot().compatibility.incompatibleClientSeen
    };
  }

  function snapshotPayload(snapshot = store.snapshot()): HudSnapshot & { capabilities?: HudCapabilities } {
    return {
      ...snapshot,
      ...(checkpointState==='disabled'?{}:{checkpoint:{state:checkpointState,...(checkpointError?{error:checkpointError}:{})}}),
      hooks: {
        activitySeen: lastHookEventAt !== undefined,
        ...(lastHookEventAt === undefined ? {} : { lastEventAt: lastHookEventAt })
      },
      ...(options.health === undefined ? {} : { capabilities: capabilities(options.health()) })
    };
  }

  function mcpSnapshot(request: IncomingMessage, snapshot: HudSnapshot): HudSnapshot {
    if (!isMcpRequest(request)) return snapshot;
    const credentials = leaseCredentials(request);
    const active = new Set(leaseStore.active().map(lease => lease.id));
    scopedSnapshots.retain(active);
    const authorized = credentials !== undefined && leaseStore.has(credentials.id, credentials.ownerNonce);
    const allowed = !authorized
      ? new Set<string>()
      : new Set(leaseStore.boundHandles(credentials!.id, credentials!.ownerNonce));
    return scopedSnapshots.project(authorized ? credentials!.id : null, snapshot, allowed);
  }

  function cancelGrace(clearHandles = true): void {
    if (graceTimer !== undefined) {
      (options.cancelTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(graceTimer);
    }
    graceTimer = undefined;
    if (clearHandles) graceHandles = new Set();
  }

  function scheduleGraceShutdown(event: { taskHandles: readonly string[] }): void {
    for (const handle of event.taskHandles) graceHandles.add(handle);
    if (leaseStore.active().length > 0) return;
    if (graceTimer !== undefined) return;
    graceTimer = (options.scheduleTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return timer;
    }))(() => {
      graceTimer = undefined;
      if (leaseStore.active().length > 0) {
        graceHandles = new Set();
        return;
      }
      const handles = [...graceHandles];
      graceHandles = new Set();
      for (const taskHandle of handles) {
        if (store.has(taskHandle, now())) {
          store.apply({ taskId: taskHandle, event: { type: "lease_lost" } }, now());
        }
      }
      if (options.requestShutdown !== undefined) {
        shuttingDown = true;
        void Promise.resolve(options.requestShutdown()).catch(() => undefined);
      }
    }, leaseGraceMs);
  }

  const handleLeaseAcquired = (): void => cancelGrace(false);
  leaseStore.on("acquired", handleLeaseAcquired);
  leaseStore.on("released", scheduleGraceShutdown);
  leaseStore.on("expired", scheduleGraceShutdown);
  let leaseResourcesDisposed = false;

  function disposeLeaseResources(): void {
    if (leaseResourcesDisposed) return;
    leaseResourcesDisposed = true;
    clearInterval(leaseSweepTimer);
    leaseStore.removeListener("acquired", handleLeaseAcquired);
    leaseStore.removeListener("released", scheduleGraceShutdown);
    leaseStore.removeListener("expired", scheduleGraceShutdown);
  }

  function requestGeneration(request: IncomingMessage): number | undefined {
    return requestNonnegativeInteger(request, REQUEST_GENERATION_HEADER);
  }

  function requestProtocol(request: IncomingMessage): number | undefined {
    const header = request.headers[REQUEST_PROTOCOL_HEADER];
    if (typeof header !== "string" || !/^\d+$/u.test(header)) return undefined;
    const protocol = Number(header);
    return Number.isSafeInteger(protocol) ? protocol : undefined;
  }

  function mcpLeaseDecision(request: IncomingMessage): TaskLeaseDecision {
    if (!isMcpRequest(request)) return "accepted";
    const credentials = leaseCredentials(request);
    return credentials !== undefined && leaseStore.has(credentials.id, credentials.ownerNonce)
      ? "accepted"
      : "lease_required";
  }

  function taskLeaseAccepted(request: IncomingMessage, taskHandle: string, allowBind = true): TaskLeaseDecision {
    const leaseDecision = mcpLeaseDecision(request);
    if (leaseDecision !== "accepted") return leaseDecision;
    if (!isMcpRequest(request)) return "accepted";
    const credentials = leaseCredentials(request);
    if (credentials === undefined) return "lease_required";
    if (leaseStore.authorize(credentials.id, credentials.ownerNonce, taskHandle)) return "accepted";
    if (!allowBind) return "lease_forbidden";
    return leaseStore.bind(credentials.id, credentials.ownerNonce, taskHandle) &&
      leaseStore.authorize(credentials.id, credentials.ownerNonce, taskHandle)
      ? "accepted"
      : "lease_forbidden";
  }

  function leaseProtocolAccepted(request: IncomingMessage): boolean {
    const protocol = requestProtocol(request);
    if (protocol !== undefined && acceptsClientProtocol(protocol)) return true;
    store.setIncompatibleClientSeen(true);
    return false;
  }

  async function runMutation(
    request: IncomingMessage,
    desiredState: DesiredHudState,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => unknown | Promise<unknown>
  ): Promise<
    | { accepted: false; reason: "version_mismatch" | "generation_rejected" | "shutting_down" | "lease_required" | "lease_forbidden" }
    | { accepted: true; value: unknown }
  > {
    const clientProtocol = requestProtocol(request);
    if (clientProtocol === undefined || !acceptsClientProtocol(clientProtocol)) {
      store.setIncompatibleClientSeen(true);
      return { accepted: false, reason: "version_mismatch" };
    }
    const leaseDecision = mcpLeaseDecision(request);
    if (leaseDecision !== "accepted") return { accepted: false, reason: leaseDecision };
    if (shuttingDown) return { accepted: false, reason: "shutting_down" };
    if (options.runIfGeneration === undefined) {
      if (signal.aborted) throw signal.reason;
      return { accepted: true, value: await operation(signal) };
    }
    const generation = requestGeneration(request);
    if (generation === undefined) return { accepted: false, reason: "generation_rejected" };
    const result = await options.runIfGeneration(generation, desiredState, operation, signal);
    return result.accepted ? result : { accepted: false, reason: "generation_rejected" };
  }

  function writeMutationRejection(
    response: ServerResponse,
    result: { accepted: false; reason: "version_mismatch" | "generation_rejected" | "shutting_down" | "lease_required" | "lease_forbidden" }
  ): void {
    if (result.reason === "version_mismatch") {
      writeJson(response, 426, {
        error: "client protocol is unsupported",
        code: "VERSION_MISMATCH"
      });
      return;
    }
    if (result.reason === "shutting_down") {
      writeJson(response, 423, { error: "shutdown in progress", code: "SHUTTING_DOWN" });
      return;
    }
    if (result.reason === "lease_required") {
      writeJson(response, 401, { error: "MCP lease is required for this session", code: "LEASE_REQUIRED" });
      return;
    }
    if (result.reason === "lease_forbidden") {
      writeJson(response, 403, { error: "MCP lease is not valid for this session", code: "LEASE_FORBIDDEN" });
      return;
    }
    writeJson(response, 409, {
      error: "lifecycle generation rejected",
      code: "GENERATION_REJECTED"
    });
  }

  function rememberHookEvent(eventId: string, receivedAt: number): void {
    hookEventIds.add(eventId);
    hookEventOrder.push(eventId);
    lastHookEventAt = lastHookEventAt === undefined ? receivedAt : Math.max(lastHookEventAt, receivedAt);
    while (hookEventOrder.length > MAX_REMEMBERED_HOOK_IDS) {
      const oldest = hookEventOrder.shift();
      if (oldest !== undefined) hookEventIds.delete(oldest);
    }
  }

  function writeStaleRevision(response: ServerResponse, request: IncomingMessage): void {
    const revision = mcpSnapshot(request, store.snapshot()).revision;
    writeJson(response, 409, {
      error: "task revision is stale",
      code: "STALE_REVISION",
      revision
    });
  }

  function writeRevisionRequired(response: ServerResponse, request: IncomingMessage): void {
    writeJson(response, 428, {
      error: "task revision is required",
      code: "REVISION_REQUIRED",
      revision: mcpSnapshot(request, store.snapshot()).revision
    });
  }

  async function handleSse(response: ServerResponse, requestedRevision: number | undefined): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff"
    });
    const send = (snapshot: HudSnapshot) => {
      return response.write(`data: ${JSON.stringify(snapshotPayload(snapshot))}\n\n`);
    };
    response.flushHeaders();
    store.on("changed", send);
    const current = store.snapshot();
    if (requestedRevision === undefined || requestedRevision !== current.revision) send(current);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    response.once("close", () => {
      clearInterval(heartbeat);
      store.off("changed", send);
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cancellation = requestCancellation(request, response);
    try {
      const unsafeTaskTarget = unsafeTaskRequestTarget(request.url ?? "/");
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          service: "codex-progress-hud",
          protocolVersion: RELEASE_CAPABILITIES.protocol.current
        });
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        if (
          request.method === "GET" &&
          options.uiDirectory !== undefined &&
          (await serveUi(response, options.uiDirectory, url.pathname))
        ) {
          return;
        }
        writeJson(response, 404, { error: "not found" });
        return;
      }

      const expectedToken = await tokenPromise;
      if (!tokensEqual(expectedToken, bearerToken(request))) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (unsafeTaskTarget) {
        writeJson(response, 404, { error: "not found" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/leases/acquire") {
        if (!hasJsonMediaType(request)) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        const payload = leaseAcquireSchema.parse(await readJson(request));
        if (!leaseProtocolAccepted(request)) {
          writeJson(response, 426, { error: "client protocol is unsupported", code: "VERSION_MISMATCH" });
          return;
        }
        const lease = leaseStore.acquire(payload.ownerNonce, payload.ttlMs);
        writeJson(response, 200, lease);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/leases/renew") {
        if (!hasJsonMediaType(request)) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        const payload = leaseMutationSchema.parse(await readJson(request));
        if (!leaseProtocolAccepted(request)) {
          writeJson(response, 426, { error: "client protocol is unsupported", code: "VERSION_MISMATCH" });
          return;
        }
        const lease = leaseStore.renew(payload.id, payload.ownerNonce, payload.ttlMs);
        if (lease === null) {
          writeJson(response, 403, { error: "MCP lease owner is invalid or expired", code: "LEASE_FORBIDDEN" });
          return;
        }
        writeJson(response, 200, lease);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/leases/release") {
        if (!hasJsonMediaType(request)) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        const payload = leaseMutationSchema.parse(await readJson(request));
        if (!leaseProtocolAccepted(request)) {
          writeJson(response, 426, { error: "client protocol is unsupported", code: "VERSION_MISMATCH" });
          return;
        }
        if (!leaseStore.release(payload.id, payload.ownerNonce)) {
          writeJson(response, 403, { error: "MCP lease owner is invalid or expired", code: "LEASE_FORBIDDEN" });
          return;
        }
        writeJson(response, 200, { released: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/leases/bind") {
        if (!hasJsonMediaType(request)) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        const payload = leaseBindSchema.parse(await readJson(request));
        if (!leaseProtocolAccepted(request)) {
          writeJson(response, 426, { error: "client protocol is unsupported", code: "VERSION_MISMATCH" });
          return;
        }
        if (!store.has(payload.taskHandle)) {
          writeJson(response, 404, {
            error: "task handle is not associated with a tracked task",
            code: "TASK_NOT_FOUND"
          });
          return;
        }
        if (!leaseStore.bind(payload.id, payload.ownerNonce, payload.taskHandle)) {
          writeJson(response, 403, { error: "task handle is not available to this MCP lease", code: "LEASE_FORBIDDEN" });
          return;
        }
        writeJson(response, 200, { bound: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        if (isMcpRequest(request) && !leaseProtocolAccepted(request)) {
          writeJson(response, 426, { error: "client protocol is unsupported", code: "VERSION_MISMATCH" });
          return;
        }
        const requestedRevision = afterRevision(url);
        const snapshot = mcpSnapshot(request, store.snapshot());
        if (requestedRevision === snapshot.revision) {
          response.writeHead(204, {
            "cache-control": "no-store",
            "x-codex-progress-hud-revision": String(snapshot.revision),
            "x-content-type-options": "nosniff"
          });
          response.end();
        } else {
          writeJson(response, 200, isMcpRequest(request) ? snapshot : snapshotPayload(snapshot));
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        if (options.bootstrap === undefined) throw new Error("renderer bootstrap is unavailable");
        writeJson(response, 200, options.bootstrap());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        if (options.health === undefined) throw new Error("health callback is unavailable");
        const health = options.health();
        const { windowDiagnostics: rawWindowDiagnostics, ...legacyHealth } = health;
        const windowDiagnostics = readWindowDiagnostics(() => rawWindowDiagnostics);
        writeJson(response, 200, { ...legacyHealth, capabilities: capabilities(health),
          ...(request.headers["x-hud-window-diagnostics"] === "1" && windowDiagnostics !== undefined ? { windowDiagnostics } : {}) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        if (isMcpRequest(request)) {
          writeJson(response, 403, { error: "aggregate stream is desktop-only", code: "LEASE_FORBIDDEN" });
          return;
        }
        await handleSse(response, afterRevision(url));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/hooks/events") {
        if (!leaseProtocolAccepted(request)) {
          writeJson(response, 426, { error: "client protocol is unsupported", code: "VERSION_MISMATCH" });
          return;
        }
        if (!hasJsonMediaType(request)) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        const envelope = parseHookEnvelope(await readJson(request));
        if(envelope.hostThreadId !== undefined &&
          `session_${createHmac('sha256',await tokenPromise).update(envelope.hostThreadId).digest('base64url')}` !== envelope.sessionKey) {
          throw new SyntaxError('invalid identity binding');
        }
        const result = await runMutation(request, "on", cancellation.signal, (signal) => {
          if (signal.aborted) throw signal.reason;
          const revision = requestRevision(request);
          if (revision === undefined) return { kind: "revision_required" as const };
          if (revision !== mcpSnapshot(request, store.snapshot()).revision) return { kind: "stale_revision" as const };
          const leaseDecision = taskLeaseAccepted(request, envelope.taskHandle);
          if (leaseDecision !== "accepted") return { kind: leaseDecision };
          // Store retention must not erase the router's replay fence.
          if (turnRouter.hasIdentity(envelope.taskHandle) && !store.has(envelope.taskHandle)) {
            return { kind: 'event_not_applied' as const };
          }
          const previousStatus = store.snapshot().tasks.find(task => task.id === envelope.taskHandle)?.status;
          if (envelope.turnKey !== undefined && previousStatus !== undefined &&
              envelope.hook !== 'SessionStart' && envelope.hook !== 'SessionEnd') {
            const event: ProgressEnvelope['event'] = envelope.hook === 'Interrupt'
              ? { type: 'runtime_interrupted' } : envelope.hook === 'Stop'
                ? { type: 'turn_stopped' } : envelope.hook === 'UserPromptSubmit'
                  ? { type: 'turn_started' } : { type: 'activity_seen', category: 'hook' };
            if (terminalEventBlocked(previousStatus, event)) return { kind: 'event_not_applied' as const };
          }
          if (hookEventIds.has(envelope.eventId)) return store.snapshot();
          if (envelope.turnKey !== undefined &&
              (envelope.hook === 'UserPromptSubmit' || envelope.hook === 'PostToolUse') &&
              !store.canAdmit(envelope.taskHandle,
                envelope.hook === 'UserPromptSubmit' ? envelope.sessionKey : undefined)) {
            store.observeTurnTracking({ capacityReached: true });
            return { kind: 'event_not_applied' as const };
          }
          const route = turnRouter.route(envelope, now());
          if (route.kind === 'apply') {
              const ownedTurn = passiveGoals.currentTurnKey(route.sessionKey);
              const follow = route.follow || (ownedTurn !== undefined && ownedTurn === route.turnKey);
              if(follow)sessionRecovery?.cancel(route.sessionKey);
            const metadata = { conversationKey: route.sessionKey, turnKey: route.turnKey, isCurrentTurn: follow };
            // Publish the goal and its current turn together. Reclaim ownership
            // before ingesting a fresh prompt so a full context store retains it.
            const observedAt = goalNow();
            // Host timestamps were authenticated/ordered above. Goal elapsed time
            // uses local monotonic arrival, not adjustable wall-clock timestamps.
            passiveGoals.observe({...envelope, receivedAt: observedAt}, follow, observedAt);
            if(selectedSource){
              pruneSources();
              if(follow&&envelope.hostThreadId!==undefined&&envelope.turnKey!==undefined){
                try{selectedSource.attach(route.sessionKey,envelope.hostThreadId,envelope.turnKey);}catch{/* source unavailable must not fail the task Hook */}
              }
              if(follow){selectedSource.changed(route.sessionKey);
                const runtime=passiveGoals.view(route.sessionKey,observedAt)?.runtime;
                if(runtime&&['paused','stopped'].includes(runtime))selectedSource.setActive(route.sessionKey,false);}
            }else passiveContexts.ingest(envelope, now());
            if (!store.has(envelope.taskHandle) && route.lateAttached) {
              store.apply({ taskId: envelope.taskHandle, event: { type: 'session_attached', origin: 'late_attach' } }, now(), metadata);
            }
            store.apply(route.envelope, now(), metadata);
            if (follow) passiveObserver?.changed(route.sessionKey, observerEventForHook(envelope));
            if(envelope.hostThreadId !== undefined && store.has(envelope.taskHandle) &&
                names.register(route.sessionKey,envelope.hostThreadId)) {
              knownConversations.add(route.sessionKey);
              refreshNames();
            }
            if (route.orderingUncertain) store.observeTurnTracking({ orderingUncertain: true });
          } else if ((route.kind==='session'&&!route.ended || route.kind==='degraded'&&route.reason==='turn_identity_unavailable'&&envelope.hook==='UserPromptSubmit')&&
            envelope.hostThreadId!==undefined&&!isMcpRequest(request)) {
            // A session hint is not a turn. Observe only this authenticated
            // thread, and publish only after fresh native start confirmation.
            sessionRecovery?.watch(envelope.sessionKey,envelope.hostThreadId,requestGeneration(request));
          } else if (route.kind === 'session' && route.ended) {
            sessionRecovery?.cancel(route.sessionKey);
            passiveContexts.ingest(envelope, now());
            // Lifecycle deletion is unconditional, even if the event fence is full.
            passiveContexts.remove(route.sessionKey);
            selectedSource?.remove(route.sessionKey);
            try{options.residualResearch?.forget(route.sessionKey);}catch{/* research-only cleanup */}
            passiveGoals.end(route.sessionKey);
            passiveObserver?.end(route.sessionKey);
            store.refreshPresentation();
          } else if (route.kind === 'degraded') {
            store.observeTurnTracking({
              ...(route.reason === 'turn_identity_unavailable' || route.reason === 'turn_identity_conflict' ? { identityUnavailable: true } : {}),
              ...(route.reason === 'turn_order_unknown' ? { orderingUncertain: true } : {}),
              ...(route.reason === 'turn_capacity_reached' ? { capacityReached: true } : {})
            });
          }
          const snapshot = store.snapshot();
          const status = snapshot.tasks.find(task => task.id === envelope.taskHandle)?.status;
          if (status !== undefined && ['succeeded_verified', 'completed_unverified', 'failed', 'interrupted'].includes(status)) {
            turnRouter.observeTerminal(envelope.taskHandle, now());
          }
          rememberHookEvent(envelope.eventId, envelope.receivedAt);
          if (!isMcpRequest(request)) {
            scheduleGraceShutdown({ taskHandles: [envelope.taskHandle] });
          }
          return snapshot;
        });
        cancellation.complete();
        if (!result.accepted) {
          writeMutationRejection(response, result);
          return;
        }
        if (result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "event_not_applied") {
          writeJson(response, 409, { code: 'EVENT_NOT_APPLIED', error: 'terminal or retained turn does not accept this event' });
          return;
        }
        if (result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "revision_required") {
          writeRevisionRequired(response, request);
          return;
        }
        if (result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "stale_revision") {
          writeStaleRevision(response, request);
          return;
        }
        if (result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "lease_required") {
          writeJson(response, 401, { error: "MCP lease is required for this session", code: "LEASE_REQUIRED" });
          return;
        }
        if (result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "lease_forbidden") {
          writeJson(response, 403, { error: "task handle is not available to this MCP lease", code: "LEASE_FORBIDDEN" });
          return;
        }
        writeJson(response, 202, mcpSnapshot(request, result.value as HudSnapshot));
        return;
      }
      const route = request.method === "POST" ? taskRoute(url.pathname) : undefined;
      if (route !== undefined) {
        if (!hasJsonMediaType(request)) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        const selectionMode = route.action === "select"
          ? selectionRequestSchema.parse(await readJson(request)).mode
          : undefined;
        const visibilityHidden = route.action === "visibility"
          ? visibilityRequestSchema.parse(await readJson(request)).hidden
          : undefined;
        const result = await runMutation(request, "on", cancellation.signal, (signal) => {
          if (signal.aborted) throw signal.reason;
          const revision = requestRevision(request);
          if (revision === undefined) return { kind: "revision_required" as const };
          if (revision !== mcpSnapshot(request, store.snapshot()).revision) return { kind: "stale_revision" as const };
          if (!store.snapshot().tasks.some((task) => task.id === route.taskId)) {
            return { kind: "task_not_found" as const };
          }
          const leaseDecision = taskLeaseAccepted(request, route.taskId, false);
          if (leaseDecision !== "accepted") return { kind: leaseDecision };
          if (route.action === 'select' && isMcpRequest(request)) {
            scopedSnapshots.select(leaseCredentials(request)!.id, route.taskId, selectionMode!);
            return store.snapshot();
          }
          const snapshot = route.action === "select"
            ? store.select(route.taskId, selectionMode!, now())
            : store.setHidden(route.taskId, visibilityHidden!, now());
          return snapshot;
        });
        cancellation.complete();
        if (!result.accepted) {
          writeMutationRejection(response, result);
          return;
        }
        if (result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value) {
          if (result.value.kind === "revision_required") {
            writeRevisionRequired(response, request);
            return;
          }
          if (result.value.kind === "stale_revision") {
            writeStaleRevision(response, request);
            return;
          }
          if (result.value.kind === "task_not_found") {
            writeJson(response, 404, { error: "task not found" });
            return;
          }
          if (result.value.kind === "lease_required") {
            writeJson(response, 401, { error: "MCP lease is required for this session", code: "LEASE_REQUIRED" });
            return;
          }
          if (result.value.kind === "lease_forbidden") {
            writeJson(response, 403, { error: "task handle is not available to this MCP lease", code: "LEASE_FORBIDDEN" });
            return;
          }
        }
        writeJson(response, 202, mcpSnapshot(request, result.value as HudSnapshot));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/events") {
        if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        if (!leaseProtocolAccepted(request)) {
          cancellation.complete();
          writeJson(response, 426, {
            error: "client protocol is unsupported",
            code: "VERSION_MISMATCH"
          });
          return;
        }
        const envelope = controlEnvelopeSchema.parse(await readJson(request));
        if (eventRequiresExistingTask(envelope.event) && !store.has(envelope.taskId)) {
          cancellation.complete();
          writeJson(response, 404, {
            error: "task handle is not associated with a tracked task",
            code: "TASK_NOT_FOUND"
          });
          return;
        }
        const result = await runMutation(request, "on", cancellation.signal, (signal) => {
          if (signal.aborted) throw signal.reason;
          const leaseDecision = taskLeaseAccepted(request, envelope.taskId);
          if (leaseDecision !== "accepted") return { kind: leaseDecision };
          const previousStatus = store.snapshot().tasks.find(task => task.id === envelope.taskId)?.status;
          if (turnRouter.hasIdentity(envelope.taskId) && !store.has(envelope.taskId)) {
            return { kind: 'event_not_applied' as const };
          }
          if (previousStatus !== undefined && terminalEventBlocked(previousStatus, envelope.event)) {
            return { kind: 'event_not_applied' as const };
          }
          if (!store.canAdmit(envelope.taskId)) {
            store.observeTurnTracking({ capacityReached: true });
            return { kind: 'event_not_applied' as const };
          }
          store.publishTogether(() => {
            const snapshot = store.apply({taskId: envelope.taskId, event: envelope.event,
              ...(envelope.title === undefined ? {} : {title: envelope.title})});
            const currentTask = snapshot.tasks.find(task => task.id === envelope.taskId);
            if (currentTask?.isCurrentTurn && currentTask.conversationKey && currentTask.turnKey && currentTask.status !== previousStatus) {
              const type = envelope.event.type;
              const runtime = type === 'tracking_paused' ? 'paused'
                : type === 'tracking_stopped' ? 'stopped'
                : type === 'tracking_resumed' || type === 'tracking_started' ? 'running' : undefined;
              if (runtime) {
                passiveGoals.runtime(currentTask.conversationKey, currentTask.turnKey, runtime, goalNow());
                if(runtime==='stopped'){selectedSource?.stop(currentTask.conversationKey);
                  try{options.residualResearch?.forget(currentTask.conversationKey);}catch{/* research-only cleanup */}}
                else selectedSource?.setActive(currentTask.conversationKey,runtime==='running');
                passiveObserver?.changed(currentTask.conversationKey, 'runtime');
                store.refreshPresentation();
              }
            }
            const status = snapshot.tasks.find(task => task.id === envelope.taskId)?.status;
            if (status !== undefined && ['succeeded_verified', 'completed_unverified', 'failed', 'interrupted'].includes(status)) {
              turnRouter.observeTerminal(envelope.taskId, now());
            }
          });
          return store.snapshot();
        });
        cancellation.complete();
        if (!result.accepted) {
          writeMutationRejection(response, result);
          return;
        }
        if (
          result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "event_not_applied"
        ) {
          writeJson(response, 409, { code: 'EVENT_NOT_APPLIED', error: 'terminal turn does not accept this event' });
          return;
        }
        if (
          result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "task_not_found"
        ) {
          writeJson(response, 404, {
            error: "task handle is not associated with a tracked task",
            code: "TASK_NOT_FOUND"
          });
          return;
        }
        if (
          result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "lease_required"
        ) {
          writeJson(response, 401, { error: "MCP lease is required for this session", code: "LEASE_REQUIRED" });
          return;
        }
        if (
          result.value !== undefined && typeof result.value === "object" && result.value !== null &&
          "kind" in result.value && result.value.kind === "lease_forbidden"
        ) {
          writeJson(response, 403, { error: "task handle is not available to this MCP lease", code: "LEASE_FORBIDDEN" });
          return;
        }
        writeJson(response, 202, mcpSnapshot(request, result.value as HudSnapshot));
        return;
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/api/window/show" ||
          url.pathname === "/api/window/hide" ||
          url.pathname === "/api/window/settings" ||
          url.pathname === "/api/shutdown")
      ) {
        if (!hasJsonMediaType(request)) {
          writeJson(response, 415, { error: "content-type must be application/json" });
          return;
        }
        await readEmptyJson(request);
        const callback =
          url.pathname === "/api/window/show"
            ? options.showWindow
            : url.pathname === "/api/window/hide"
              ? options.hideWindow
              : url.pathname === "/api/window/settings"
                ? options.openSettings
                : options.requestShutdown;
        if (callback === undefined) throw new Error("control callback is unavailable");
        const desiredState = url.pathname === "/api/shutdown" &&
          request.headers[COMPATIBILITY_CLOSE_HEADER] !== "true" ? "off" : "on";
        const result = await runMutation(request, desiredState, cancellation.signal, async (signal) => {
          if (signal.aborted) throw signal.reason;
          if (url.pathname === "/api/shutdown") {
            if (signal.aborted) throw signal.reason;
            shuttingDown = true;
          }
          if (signal.aborted) throw signal.reason;
          await callback();
        });
        cancellation.complete();
        if (!result.accepted) {
          writeMutationRejection(response, result);
          return;
        }
        writeJson(response, 202, { accepted: true });
        return;
      }
      writeJson(response, 404, { error: "not found" });
    } catch (error) {
      if (cancellation.signal.reason instanceof RequestDeadlineExpiredError) {
        writeJson(response, 408, { error: "request deadline expired" });
      } else if (error instanceof BodyTooLargeError) {
        writeJson(response, 413, { error: error.message });
      } else if (error instanceof SyntaxError || error instanceof ZodError) {
        writeJson(response, 400, { error: "invalid request payload" });
      } else {
        writeJson(response, 500, { error: "internal server error" });
      }
    } finally {
      cancellation.dispose();
    }
  }

  return {
    store,
    leaseStore,
    hookActivity: () => ({
      activitySeen: lastHookEventAt !== undefined,
      ...(lastHookEventAt === undefined ? {} : { lastEventAt: lastHookEventAt })
    }),
    async listen(): Promise<void> {
      await tokenPromise;
      if (server !== undefined) return;
      if(!checkpointReady){
        if(!checkpointRepository&&selectedSource&&options.isGoalCheckpointOwner){
          const root=resolve(options.observerSessionsRoot!);
          checkpointRepository=createGoalCheckpointRepository({directory:dirname(options.tokenPath),
            sourceIdentity:createHmac('sha256',sourceToken!).update(process.platform==='win32'?root.toLowerCase():root).digest('hex'),
            isOwner:options.isGoalCheckpointOwner,now});
          milestoneRepository=createMilestoneCheckpointRepository({directory:dirname(options.tokenPath),
            sourceIdentity:createHmac('sha256',sourceToken!).update(process.platform==='win32'?root.toLowerCase():root).digest('hex'),
            isOwner:options.isGoalCheckpointOwner,now});
        }
        if(checkpointRepository){
          checkpointState='loading';
          try{passiveGoals.restoreCheckpoint(await checkpointRepository.load(),now());checkpointState='ready';}
          catch{checkpointState='degraded';checkpointError='read_failed';}
          try{if(milestoneRepository)passiveGoals.restoreMilestoneCheckpoint(await milestoneRepository.load());}
          catch{checkpointState='degraded';checkpointError='read_failed';}
          checkpointReady=true;
        }
      }
      server = createServer((request, response) => void handle(request, response));
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(requestedPort, host, () => resolve());
      });
      const bound = server.address();
      if (bound === null || typeof bound === "string") throw new Error("unexpected server address");
      currentAddress = { host, port: bound.port, url: `http://${host}:${bound.port}` };
      if(checkpointRepository){
        checkpointInterval=setInterval(()=>{void saveCheckpoint();},5000);
        checkpointInterval.unref();
      }
      if (passiveObserver) {
        if(selectedSource){
          sourceTimer=setInterval(()=>{try{sessionRecovery?.tick();selectedSource.tick();}catch{/* source errors do not authorize model retries */}},250);
          sourceTimer.unref();
        }
        observerTimer = setInterval(() => {
          passiveObserver.tickSafely();
        }, 1000);
        observerTimer.unref();
      }
      if (options.awaitInitialLease) scheduleGraceShutdown({ taskHandles: [] });
    },
    async close(): Promise<void> {
      shuttingDown = true;
      sessionRecovery?.close();
      clearTimeout(checkpointTimer);clearInterval(checkpointInterval);
      store.off('changed',scheduleCheckpoint);
      clearInterval(observerTimer);
      clearInterval(sourceTimer);
      await saveCheckpoint();
      passiveObserver?.disable();
      passiveContexts.clear();
      passiveGoals.clear();
      clearInterval(nameTimer);
      names.disable();
      knownConversations.clear();
      store.off('changed',refreshNames);
      // Finish core cleanup even if a title child could not be terminated.
      let nameCleanupFailed=false;
      let observerCleanupFailed=false;
      try {await selectedSource?.close();} catch {observerCleanupFailed=true;}
      try {await passiveObserver?.close();} catch {observerCleanupFailed=true;}
      try { await options.closeConversationNames?.(); } catch { nameCleanupFailed=true; }
      cancelGrace();
      disposeLeaseResources();
      if (server === undefined) {
        if(observerCleanupFailed)throw Error('OBSERVER_CLOSE_UNCONFIRMED');
        if(nameCleanupFailed)throw Error('NAME_TERMINATION_FAILED');
        return;
      }
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error === undefined ? resolve() : reject(error)))
      );
      server = undefined;
      currentAddress = undefined;
      if(observerCleanupFailed)throw Error('OBSERVER_CLOSE_UNCONFIRMED');
      if(nameCleanupFailed)throw Error('NAME_TERMINATION_FAILED');
    },
    address(): ProgressServerAddress {
      if (currentAddress === undefined) throw new Error("progress server is not listening");
      return currentAddress;
    }
  };
}
