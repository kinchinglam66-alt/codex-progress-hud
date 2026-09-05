import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProgressEnvelope } from "../core/schema.js";
import type {
  CompanionManager,
  MakeHudRequestOptions
} from "../lifecycle/companion-manager.js";
import type {
  EnsureResult,
  HudErrorCode,
  HudLifecycleSnapshot,
  HudWriteReason,
  ObservedHudState
} from "../lifecycle/types.js";
import {
  HudClientError,
  type HudClientErrorCode,
  type HudRequestOptions,
  type ProgressClient,
  type ProgressClientSnapshot
} from "./report-client.js";
import {
  createFallbackTaskHandle as generateFallbackTaskHandle,
  resolveTaskAssociation,
  type ResolvedTaskAssociation,
  type TaskAssociationSource
} from "./task-association.js";

export const taskHandleSchema = z.string().regex(/^hud_[A-Za-z0-9_-]{20,96}$/u);
const title = z.string().trim().min(1).max(160);
const phase = z.string().trim().min(1).max(80);
const step = z.string().trim().max(160);
const boundedSeconds = z.number().finite().nonnegative().max(31_536_000);
export const trackingStartSchema = z.object({
  task_handle: taskHandleSchema.optional(),
  title: title.optional()
}).strict();
export const taskControlSchema = z.object({
  task_handle: taskHandleSchema.optional()
}).strict();

export const progressReportSchema = z
  .object({
    task_handle: taskHandleSchema.optional(),
    title: title.optional(),
    phase,
    current_step: step.optional(),
    progress: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    eta_low_seconds: boundedSeconds.optional(),
    eta_high_seconds: boundedSeconds.optional(),
    waiting_for: z.enum(["approval", "user"]).optional()
  }).strict()
  .refine(
    (value) =>
      (value.eta_low_seconds === undefined) === (value.eta_high_seconds === undefined),
    { message: "ETA low and high values must be provided together" }
  )
  .refine(
    (value) =>
      value.eta_low_seconds === undefined || value.eta_low_seconds <= value.eta_high_seconds!,
    { message: "ETA low value cannot exceed ETA high value" }
  );

export const taskOutcomeSchema = z.object({
  task_handle: taskHandleSchema.optional(),
  title: title.optional(),
  outcome: z.enum(["completed", "blocked", "failed"]),
  verified: z.boolean().default(false),
  detail: z.string().trim().max(240).optional()
}).strict();

export const validationObservedSchema = z.object({
  task_handle: taskHandleSchema.optional(),
  result: z.enum(["passed", "failed"])
}).strict();

export interface ToolResult extends CallToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: HudToolPayload;
}

export interface HudToolPayload {
  [key: string]: unknown;
  ok: boolean;
  associationSource?: TaskAssociationSource;
  desiredState?: "on" | "off";
  observedState?: ObservedHudState;
  code?: HudErrorCode | HudClientErrorCode;
  reportPath?: string;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function structuredResult(text: string, payload: HudToolPayload, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {})
  };
}

function invalidResult(kind: string): ToolResult {
  return { content: [{ type: "text", text: `Invalid ${kind}.` }], isError: true };
}

function clientFailureResult(
  error?: unknown,
  associationSource?: TaskAssociationSource
): ToolResult {
  const code = error instanceof HudClientError ? error.code : "INTERNAL_ERROR";
  const text = clientFailureText(code, "Progress HUD request failed");
  return structuredResult(
    text,
    { ok: false, ...(associationSource === undefined ? {} : { associationSource }), code },
    true
  );
}

function clientFailureText(code: HudClientErrorCode | HudErrorCode, prefix: string): string {
  return code === "VERSION_MISMATCH"
    ? `${prefix} (${code}). Progress HUD plugin and companion versions do not match. Update the plugin and companion, then fully quit Codex, reopen it, and begin or resume a task with Progress HUD tracking enabled.`
    : `${prefix} (${code}). Check HUD status or run diagnostics.`;
}

function submittedTaskStatus(snapshot: ProgressClientSnapshot, taskHandle: string): string {
  if ("tasks" in snapshot) {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskHandle);
    if (task !== undefined) return task.status;
    if (snapshot.selected?.task.id === taskHandle) return snapshot.selected.task.status;
    return "accepted";
  }
  return snapshot.task?.id === undefined || snapshot.task.id === taskHandle
    ? snapshot.task?.status ?? "accepted"
    : "accepted";
}

const TERMINAL_TASK_STATUSES = new Set([
  "ended_unknown",
  "completed_unverified",
  "succeeded_verified",
  "failed",
  "interrupted"
]);

function submittedTaskIsTerminal(snapshot: ProgressClientSnapshot, taskHandle: string): boolean {
  return TERMINAL_TASK_STATUSES.has(submittedTaskStatus(snapshot, taskHandle));
}

async function submitForTask(
  client: ProgressClient,
  association: ResolvedTaskAssociation,
  event: ProgressEnvelope["event"],
  requestOptions: () => HudRequestOptions
): Promise<ToolResult> {
  const snapshot = await client.submit({
    taskId: association.taskHandle,
    event
  }, requestOptions());
  return structuredResult(
    `Tracking ${event.type.replace("tracking_", "")}: ${submittedTaskStatus(snapshot, association.taskHandle)}.`,
    { ok: true, associationSource: association.source }
  );
}

export interface ToolHandlerDependencies {
  progressClient: ProgressClient;
  companionManager: CompanionManager;
  fallbackTaskHandle: string;
  createFallbackTaskHandle?: () => string;
}

type WriteExecution<T> =
  | { kind: "completed"; value: T }
  | Exclude<EnsureResult, { kind: "ready" }>
  | { kind: "exception"; error: unknown };

export function createToolHandlers({
  progressClient: client,
  companionManager,
  fallbackTaskHandle,
  createFallbackTaskHandle = generateFallbackTaskHandle
}: ToolHandlerDependencies) {
  let currentFallbackTaskHandle = fallbackTaskHandle;
  let fallbackStartFlight: Promise<ToolResult> | undefined;

  function lifecycleErrorResult(
    result: Extract<EnsureResult, { kind: "error" }>,
    association: ResolvedTaskAssociation
  ): ToolResult {
    return structuredResult(
      clientFailureText(result.code, "Progress HUD lifecycle failed"),
      {
        ok: false,
        associationSource: association.source,
        ...(result.snapshot.desiredState === undefined
          ? {}
          : { desiredState: result.snapshot.desiredState }),
        observedState: result.snapshot.observedState,
        code: result.code
      },
      true
    );
  }

  function suppressedResult(text: string, association: ResolvedTaskAssociation): ToolResult {
    return structuredResult(text, {
      ok: true,
      associationSource: association.source,
      desiredState: "off",
      code: "MANUALLY_DISABLED"
    });
  }

  function mapWriteExecution<T>(
    execution: WriteExecution<T>,
    association: ResolvedTaskAssociation,
    suppressedText: string,
    completed: (value: T) => ToolResult
  ): ToolResult {
    if (execution.kind === "completed") return completed(execution.value);
    if (execution.kind === "suppressed") return suppressedResult(suppressedText, association);
    if (execution.kind === "error") return lifecycleErrorResult(execution, association);
    return clientFailureResult(execution.error, association.source);
  }

  async function executeWrite<T>(
    reason: HudWriteReason,
    operation: (makeRequestOptions: MakeHudRequestOptions) => Promise<T>
  ): Promise<WriteExecution<T>> {
    try {
      return await companionManager.executeWrite(reason, operation);
    } catch (error) {
      return { kind: "exception", error };
    }
  }

  async function fallbackAssociation(explicitTaskHandle: string | undefined): Promise<ResolvedTaskAssociation> {
    if (explicitTaskHandle === undefined && fallbackStartFlight !== undefined) {
      await fallbackStartFlight.catch(() => undefined);
    }
    return resolveTaskAssociation(explicitTaskHandle, currentFallbackTaskHandle);
  }

  async function runWrite(
    association: ResolvedTaskAssociation,
    reason: HudWriteReason,
    suppressedText: string,
    operation: (makeRequestOptions: MakeHudRequestOptions) => Promise<ToolResult>
  ): Promise<ToolResult> {
    return mapWriteExecution(
      await executeWrite(reason, operation),
      association,
      suppressedText,
      (value) => value
    );
  }

  async function handleFreeTrackingStart(title_: string): Promise<ToolResult> {
    const association = resolveTaskAssociation(undefined, currentFallbackTaskHandle);
    let replacementTaskHandle: string | undefined;
    const execution = await executeWrite(
      "tracking_start",
      async (makeRequestOptions) => {
        const firstSnapshot = await client.submit({
          taskId: association.taskHandle,
          title: title_,
          event: { type: "tracking_started" }
        }, makeRequestOptions());
        if (!submittedTaskIsTerminal(firstSnapshot, association.taskHandle)) {
          return {
            result: structuredResult(
              `Tracking started: ${submittedTaskStatus(firstSnapshot, association.taskHandle)}.`,
              { ok: true, associationSource: association.source }
            )
          };
        }

        replacementTaskHandle ??= createFallbackTaskHandle();
        const replacementSnapshot = await client.submit({
          taskId: replacementTaskHandle,
          title: title_,
          event: { type: "tracking_started" }
        }, makeRequestOptions());
        return {
          result: structuredResult(
            `Tracking started: ${submittedTaskStatus(replacementSnapshot, replacementTaskHandle)}.`,
            { ok: true, associationSource: association.source }
          ),
          replacementTaskHandle
        };
      }
    );
    return mapWriteExecution(
      execution,
      association,
      "HUD is manually closed; tracking was not started.",
      (value) => {
        if (value.replacementTaskHandle !== undefined) {
          currentFallbackTaskHandle = value.replacementTaskHandle;
        }
        return value.result;
      }
    );
  }

  function queueHandleFreeTrackingStart(title_: string): Promise<ToolResult> {
    const previous = fallbackStartFlight;
    const flight = (async () => {
      if (previous !== undefined) await previous.catch(() => undefined);
      return handleFreeTrackingStart(title_);
    })();
    fallbackStartFlight = flight;
    void flight.then(
      () => { if (fallbackStartFlight === flight) fallbackStartFlight = undefined; },
      () => { if (fallbackStartFlight === flight) fallbackStartFlight = undefined; }
    );
    return flight;
  }

  function lifecycleResult(
    action: "open" | "hidden" | "closed",
    snapshot: HudLifecycleSnapshot,
    observational = false
  ): ToolResult {
    const payload: HudToolPayload = {
      ok: observational || snapshot.code === undefined,
      ...(snapshot.desiredState === undefined ? {} : { desiredState: snapshot.desiredState }),
      observedState: snapshot.observedState,
      ...(snapshot.code === undefined ? {} : { code: snapshot.code })
    };
    const text = observational
      ? `Progress HUD is ${snapshot.observedState}.`
        : snapshot.code === undefined
          ? `Progress HUD is ${action}.`
          : clientFailureText(snapshot.code, "Progress HUD lifecycle failed");
    return structuredResult(text, payload, !observational && snapshot.code !== undefined);
  }

  async function taskStatus(): Promise<ToolResult> {
    try {
      const snapshot = await client.status();
      return textResult(JSON.stringify(snapshot));
    } catch (error) {
      return clientFailureResult(error);
    }
  }

  return {
    async progressReport(input: unknown): Promise<ToolResult> {
      const parsed = progressReportSchema.safeParse(input);
      if (!parsed.success) return invalidResult("progress report");
      const value = parsed.data;
      const association = await fallbackAssociation(value.task_handle);
      let event: ProgressEnvelope["event"];
      if (value.waiting_for !== undefined) {
        event = {
          type: "waiting",
          reason: value.waiting_for,
          ...(value.current_step === undefined ? {} : { detail: value.current_step })
        };
      } else {
        const remainingSeconds =
          value.eta_low_seconds === undefined
            ? undefined
            : (value.eta_low_seconds + value.eta_high_seconds!) / 2;
        event = {
          type: "model_progress",
          phase: value.phase,
          ...(value.current_step === undefined ? {} : { currentStep: value.current_step }),
          ...(value.progress === undefined ? {} : { progress: value.progress }),
          ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
          ...(remainingSeconds === undefined ? {} : { remainingSeconds })
        };
      }
      return runWrite(
        association,
        "progress_report",
        "HUD is manually closed; progress was not displayed.",
        async (makeRequestOptions) => {
          const snapshot = await client.submit({
            taskId: association.taskHandle,
            ...(value.title === undefined ? {} : { title: value.title }),
            event
          }, makeRequestOptions());
          return structuredResult(
            `Progress recorded: ${submittedTaskStatus(snapshot, association.taskHandle)}.`,
            { ok: true, associationSource: association.source }
          );
        }
      );
    },

    async taskOutcome(input: unknown): Promise<ToolResult> {
      const parsed = taskOutcomeSchema.safeParse(input);
      if (!parsed.success) return invalidResult("task outcome");
      const value = parsed.data;
      const association = await fallbackAssociation(value.task_handle);
      return runWrite(
        association,
        "task_outcome",
        "HUD is manually closed; the outcome was not displayed.",
        async (makeRequestOptions) => {
          const snapshot = await client.submit({
            taskId: association.taskHandle,
            ...(value.title === undefined ? {} : { title: value.title }),
            event: {
              type: "model_outcome",
              outcome: value.outcome,
              verified: value.verified,
              ...(value.detail === undefined ? {} : { detail: value.detail })
            }
          }, makeRequestOptions());
          return structuredResult(
            `Outcome recorded: ${submittedTaskStatus(snapshot, association.taskHandle)}.`,
            { ok: true, associationSource: association.source }
          );
        }
      );
    },

    async validationObserved(input: unknown): Promise<ToolResult> {
      const parsed = validationObservedSchema.safeParse(input);
      if (!parsed.success) return invalidResult("validation observation");
      const value = parsed.data;
      const association = await fallbackAssociation(value.task_handle);
      return runWrite(
        association,
        "task_outcome",
        "HUD is manually closed; validation evidence was not displayed.",
        async (makeRequestOptions) => {
          const snapshot = await client.submit({
            taskId: association.taskHandle,
            event: { type: "validation_observed", result: value.result }
          }, makeRequestOptions());
          return structuredResult(
            `Validation ${value.result}: ${submittedTaskStatus(snapshot, association.taskHandle)}.`,
            { ok: true, associationSource: association.source }
          );
        }
      );
    },

    taskStatus,

    async trackingStart(input: unknown): Promise<ToolResult> {
      const parsed = trackingStartSchema.safeParse(input === undefined ? {} : input);
      if (!parsed.success) return invalidResult("tracking start");
      if (parsed.data.task_handle === undefined) {
        return queueHandleFreeTrackingStart(parsed.data.title ?? "Codex task");
      }
      const association = resolveTaskAssociation(parsed.data.task_handle, currentFallbackTaskHandle);
      return runWrite(
        association,
        "tracking_start",
        "HUD is manually closed; tracking was not started.",
        async (makeRequestOptions) => {
          const taskTitle = parsed.data.title ?? "Codex task";
          const snapshot = await client.submit({
            taskId: association.taskHandle,
            title: taskTitle,
            event: { type: "tracking_started" }
          }, makeRequestOptions());
          return structuredResult(
            `Tracking started: ${submittedTaskStatus(snapshot, association.taskHandle)}.`,
            { ok: true, associationSource: association.source }
          );
        }
      );
    },

    async trackingPause(input?: unknown): Promise<ToolResult> {
      const parsed = taskControlSchema.safeParse(input === undefined ? {} : input);
      if (!parsed.success) return invalidResult("tracking pause");
      const association = await fallbackAssociation(parsed.data.task_handle);
      return runWrite(
        association,
        "progress_report",
        "HUD is manually closed; tracking was not paused.",
        (makeRequestOptions) =>
          submitForTask(client, association, { type: "tracking_paused" }, makeRequestOptions)
      );
    },

    async trackingResume(input?: unknown): Promise<ToolResult> {
      const parsed = taskControlSchema.safeParse(input === undefined ? {} : input);
      if (!parsed.success) return invalidResult("tracking resume");
      const association = await fallbackAssociation(parsed.data.task_handle);
      return runWrite(
        association,
        "progress_report",
        "HUD is manually closed; tracking was not resumed.",
        (makeRequestOptions) =>
          submitForTask(client, association, { type: "tracking_resumed" }, makeRequestOptions)
      );
    },

    async trackingStop(input?: unknown): Promise<ToolResult> {
      const parsed = taskControlSchema.safeParse(input === undefined ? {} : input);
      if (!parsed.success) return invalidResult("tracking stop");
      const association = await fallbackAssociation(parsed.data.task_handle);
      return runWrite(
        association,
        "progress_report",
        "HUD is manually closed; tracking was not stopped.",
        (makeRequestOptions) =>
          submitForTask(client, association, { type: "tracking_stopped" }, makeRequestOptions)
      );
    },

    trackingStatus: taskStatus,

    async hudOpen(): Promise<ToolResult> {
      try {
        return lifecycleResult("open", await companionManager.open());
      } catch (error) {
        const code = error instanceof HudClientError ? error.code : "INTERNAL_ERROR";
        return structuredResult(
          clientFailureText(code, "Progress HUD could not be opened"),
          { ok: false, code },
          true
        );
      }
    },

    async hudHide(): Promise<ToolResult> {
      try {
        return lifecycleResult("hidden", await companionManager.hide());
      } catch (error) {
        const code = error instanceof HudClientError ? error.code : "INTERNAL_ERROR";
        return structuredResult(
          clientFailureText(code, "Progress HUD could not be hidden"),
          { ok: false, code },
          true
        );
      }
    },

    async hudClose(): Promise<ToolResult> {
      try {
        return lifecycleResult("closed", await companionManager.close({ persistDesiredState: false }));
      } catch (error) {
        const code = error instanceof HudClientError ? error.code : "INTERNAL_ERROR";
        return structuredResult(
          clientFailureText(code, "Progress HUD could not be closed"),
          { ok: false, code },
          true
        );
      }
    },

    async hudStatus(): Promise<ToolResult> {
      try {
        return lifecycleResult("open", await companionManager.status(), true);
      } catch (error) {
        const code = error instanceof HudClientError ? error.code : "INTERNAL_ERROR";
        return structuredResult(
          clientFailureText(code, "Progress HUD status could not be read"),
          { ok: false, code },
          true
        );
      }
    },

    async hudDiagnose(): Promise<ToolResult> {
      try {
        const report = await companionManager.diagnose();
        return structuredResult(`HUD diagnostic report created: ${report.path}`, {
          ok: true,
          reportPath: report.path
        });
      } catch (error) {
        const code = error instanceof HudClientError ? error.code : "INTERNAL_ERROR";
        return structuredResult(
          clientFailureText(code, "Progress HUD diagnostics failed"),
          { ok: false, code },
          true
        );
      }
    }
  };
}
