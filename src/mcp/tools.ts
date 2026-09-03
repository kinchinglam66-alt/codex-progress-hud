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
    task_handle: taskHandleSchema,
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
  task_handle: taskHandleSchema,
  title: title.optional(),
  outcome: z.enum(["completed", "blocked", "failed"]),
  verified: z.boolean().default(false),
  detail: z.string().trim().max(240).optional()
}).strict();

export const validationObservedSchema = z.object({
  task_handle: taskHandleSchema,
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
  desiredState?: "on" | "off";
  observedState?: ObservedHudState;
  code?: HudErrorCode | HudClientErrorCode | "NO_SESSION_ASSOCIATION";
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

function clientFailureResult(error?: unknown): ToolResult {
  const code = error instanceof HudClientError ? error.code : "INTERNAL_ERROR";
  const text = clientFailureText(code, "Progress HUD request failed");
  return structuredResult(
    text,
    { ok: false, code },
    true
  );
}

function clientFailureText(code: HudClientErrorCode | HudErrorCode, prefix: string): string {
  return code === "VERSION_MISMATCH"
    ? `${prefix} (${code}). Progress HUD plugin and companion versions do not match. Update the plugin and companion, then fully quit Codex, reopen it, and begin or resume a Hook-enabled task.`
    : `${prefix} (${code}). Check HUD status or run diagnostics.`;
}

function noSessionAssociationResult(): ToolResult {
  return structuredResult(
    "No Hook session association is available. Use the task_handle supplied by SessionStart or UserPromptSubmit.",
    { ok: false, code: "NO_SESSION_ASSOCIATION" },
    true
  );
}

function controlHandle(input: unknown, kind: string): string | ToolResult {
  const parsed = taskControlSchema.safeParse(input ?? {});
  if (parsed.success && parsed.data.task_handle !== undefined) return parsed.data.task_handle;
  if (parsed.success) return noSessionAssociationResult();
  if (
    input === undefined ||
    input === null ||
    (typeof input === "object" && input !== null && !Array.isArray(input) &&
      !("task_handle" in input))
  ) {
    return noSessionAssociationResult();
  }
  return invalidResult(kind);
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
  taskHandle: string,
  event: ProgressEnvelope["event"],
  requestOptions: () => HudRequestOptions
): Promise<ToolResult> {
  const snapshot = await client.submit({
    taskId: taskHandle,
    event
  }, requestOptions());
  return textResult(
    `Tracking ${event.type.replace("tracking_", "")}: ${submittedTaskStatus(snapshot, taskHandle)}.`
  );
}

export interface ToolHandlerDependencies {
  progressClient: ProgressClient;
  companionManager: CompanionManager;
}

export function createToolHandlers({
  progressClient: client,
  companionManager
}: ToolHandlerDependencies) {
  function lifecycleErrorResult(result: Extract<EnsureResult, { kind: "error" }>): ToolResult {
    return structuredResult(
      clientFailureText(result.code, "Progress HUD lifecycle failed"),
      {
        ok: false,
        ...(result.snapshot.desiredState === undefined
          ? {}
          : { desiredState: result.snapshot.desiredState }),
        observedState: result.snapshot.observedState,
        code: result.code
      },
      true
    );
  }

  function suppressedResult(text: string): ToolResult {
    return structuredResult(text, {
      ok: true,
      desiredState: "off",
      code: "MANUALLY_DISABLED"
    });
  }

  async function runWrite(
    reason: HudWriteReason,
    suppressedText: string,
    operation: (makeRequestOptions: MakeHudRequestOptions) => Promise<ToolResult>
  ): Promise<ToolResult> {
    try {
      const result = await companionManager.executeWrite(reason, operation);
      if (result.kind === "completed") return result.value;
      if (result.kind === "suppressed") return suppressedResult(suppressedText);
      return lifecycleErrorResult(result);
    } catch (error) {
      return clientFailureResult(error);
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
        "progress_report",
        "HUD is manually closed; progress was not displayed.",
        async (makeRequestOptions) => {
          const snapshot = await client.submit({
            taskId: value.task_handle,
            ...(value.title === undefined ? {} : { title: value.title }),
            event
          }, makeRequestOptions());
          return textResult(`Progress recorded: ${submittedTaskStatus(snapshot, value.task_handle)}.`);
        }
      );
    },

    async taskOutcome(input: unknown): Promise<ToolResult> {
      const parsed = taskOutcomeSchema.safeParse(input);
      if (!parsed.success) return invalidResult("task outcome");
      const value = parsed.data;
      return runWrite(
        "task_outcome",
        "HUD is manually closed; the outcome was not displayed.",
        async (makeRequestOptions) => {
          const snapshot = await client.submit({
            taskId: value.task_handle,
            ...(value.title === undefined ? {} : { title: value.title }),
            event: {
              type: "model_outcome",
              outcome: value.outcome,
              verified: value.verified,
              ...(value.detail === undefined ? {} : { detail: value.detail })
            }
          }, makeRequestOptions());
          return textResult(`Outcome recorded: ${submittedTaskStatus(snapshot, value.task_handle)}.`);
        }
      );
    },

    async validationObserved(input: unknown): Promise<ToolResult> {
      const parsed = validationObservedSchema.safeParse(input);
      if (!parsed.success) return invalidResult("validation observation");
      const value = parsed.data;
      return runWrite(
        "task_outcome",
        "HUD is manually closed; validation evidence was not displayed.",
        async (makeRequestOptions) => {
          const snapshot = await client.submit({
            taskId: value.task_handle,
            event: { type: "validation_observed", result: value.result }
          }, makeRequestOptions());
          return textResult(`Validation ${value.result}: ${submittedTaskStatus(snapshot, value.task_handle)}.`);
        }
      );
    },

    taskStatus,

    async trackingStart(input: unknown): Promise<ToolResult> {
      const parsed = trackingStartSchema.safeParse(input ?? {});
      if (!parsed.success) {
        if (
          input === undefined ||
          input === null ||
          (typeof input === "object" && input !== null && !Array.isArray(input) &&
            !("task_handle" in input))
        ) {
          return noSessionAssociationResult();
        }
        return invalidResult("tracking start");
      }
      const taskHandle = parsed.data.task_handle;
      if (taskHandle === undefined) return noSessionAssociationResult();
      return runWrite(
        "tracking_start",
        "HUD is manually closed; tracking was not started.",
        async (makeRequestOptions) => {
          const taskTitle = parsed.data.title ?? "Codex task";
          const snapshot = await client.submit({
            taskId: taskHandle,
            title: taskTitle,
            event: { type: "tracking_started" }
          }, makeRequestOptions());
          return textResult(`Tracking started: ${submittedTaskStatus(snapshot, taskHandle)}.`);
        }
      );
    },

    async trackingPause(input?: unknown): Promise<ToolResult> {
      const handle = controlHandle(input, "tracking pause");
      if (typeof handle !== "string") return handle;
      return runWrite(
        "progress_report",
        "HUD is manually closed; tracking was not paused.",
        (makeRequestOptions) =>
          submitForTask(client, handle, { type: "tracking_paused" }, makeRequestOptions)
      );
    },

    async trackingResume(input?: unknown): Promise<ToolResult> {
      const handle = controlHandle(input, "tracking resume");
      if (typeof handle !== "string") return handle;
      return runWrite(
        "progress_report",
        "HUD is manually closed; tracking was not resumed.",
        (makeRequestOptions) =>
          submitForTask(client, handle, { type: "tracking_resumed" }, makeRequestOptions)
      );
    },

    async trackingStop(input?: unknown): Promise<ToolResult> {
      const handle = controlHandle(input, "tracking stop");
      if (typeof handle !== "string") return handle;
      return runWrite(
        "progress_report",
        "HUD is manually closed; tracking was not stopped.",
        (makeRequestOptions) =>
          submitForTask(client, handle, { type: "tracking_stopped" }, makeRequestOptions)
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
