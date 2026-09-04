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
    ? `${prefix} (${code}). Progress HUD plugin and companion versions do not match. Update the plugin and companion, then fully quit Codex, reopen it, and begin or resume a Hook-enabled task.`
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
}

export function createToolHandlers({
  progressClient: client,
  companionManager,
  fallbackTaskHandle
}: ToolHandlerDependencies) {
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

  async function runWrite(
    association: ResolvedTaskAssociation,
    reason: HudWriteReason,
    suppressedText: string,
    operation: (makeRequestOptions: MakeHudRequestOptions) => Promise<ToolResult>
  ): Promise<ToolResult> {
    try {
      const result = await companionManager.executeWrite(reason, (makeRequestOptions) =>
        operation(() => ({
          ...makeRequestOptions(),
          ...(association.source === "explicit" ? { retryOnLeaseForbidden: false } : {})
        }))
      );
      if (result.kind === "completed") return result.value;
      if (result.kind === "suppressed") return suppressedResult(suppressedText, association);
      return lifecycleErrorResult(result, association);
    } catch (error) {
      return clientFailureResult(error, association.source);
    }
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
      const association = resolveTaskAssociation(value.task_handle, fallbackTaskHandle);
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
      const association = resolveTaskAssociation(value.task_handle, fallbackTaskHandle);
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
      const association = resolveTaskAssociation(value.task_handle, fallbackTaskHandle);
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
      const association = resolveTaskAssociation(parsed.data.task_handle, fallbackTaskHandle);
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
      const association = resolveTaskAssociation(parsed.data.task_handle, fallbackTaskHandle);
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
      const association = resolveTaskAssociation(parsed.data.task_handle, fallbackTaskHandle);
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
      const association = resolveTaskAssociation(parsed.data.task_handle, fallbackTaskHandle);
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
