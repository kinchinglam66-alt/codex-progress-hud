import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProgressEnvelope } from "../core/schema.js";
import type { CompanionManager } from "../lifecycle/companion-manager.js";
import type {
  EnsureResult,
  HudErrorCode,
  HudLifecycleSnapshot,
  ObservedHudState
} from "../lifecycle/types.js";
import { HudClientError, type ProgressClient } from "./report-client.js";

const id = z.string().trim().min(1).max(128);
const title = z.string().trim().min(1).max(160);
export const trackingStartSchema = z.object({
  task_id: id.optional(),
  title: title.optional()
});

export const progressReportSchema = z
  .object({
    task_id: id,
    title,
    phase: z.string().trim().min(1).max(80),
    current_step: z.string().trim().max(160).optional(),
    progress: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    eta_low_seconds: z.number().nonnegative().max(31_536_000).optional(),
    eta_high_seconds: z.number().nonnegative().max(31_536_000).optional(),
    waiting_for: z.enum(["approval", "user"]).optional()
  })
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
  task_id: id,
  title,
  outcome: z.enum(["completed", "blocked", "failed"]),
  verified: z.boolean().default(false),
  detail: z.string().trim().max(240).optional()
});

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
  code?: HudErrorCode;
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

function clientFailureResult(): ToolResult {
  return structuredResult(
    "Progress HUD is unreachable or returned an invalid response. Check HUD status or run diagnostics.",
    { ok: false, code: "INTERNAL_ERROR" },
    true
  );
}

function noActiveTaskResult(): ToolResult {
  return { content: [{ type: "text", text: "No active task to control." }], isError: true };
}

async function submitForCurrentTask(
  client: ProgressClient,
  event: ProgressEnvelope["event"]
): Promise<ToolResult> {
  const current = await client.status();
  if (
    current.task === null ||
    current.task.id === undefined ||
    current.task.title === undefined
  ) {
    return noActiveTaskResult();
  }
  const snapshot = await client.submit({
    taskId: current.task.id,
    title: current.task.title,
    event
  });
  return textResult(
    `Tracking ${event.type.replace("tracking_", "")}: ${snapshot.task?.status ?? "idle"}.`
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
      `Progress HUD lifecycle failed (${result.code}). Check HUD status or run diagnostics.`,
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

  async function ensure(
    reason: Parameters<CompanionManager["ensureForWrite"]>[0],
    suppressedText: string
  ): Promise<ToolResult | undefined> {
    try {
      const result = await companionManager.ensureForWrite(reason);
      if (result.kind === "suppressed") return suppressedResult(suppressedText);
      if (result.kind === "error") return lifecycleErrorResult(result);
      return undefined;
    } catch {
      return structuredResult(
        "Progress HUD lifecycle failed (INTERNAL_ERROR). Run HUD diagnostics.",
        { ok: false, code: "INTERNAL_ERROR" },
        true
      );
    }
  }

  async function runWrite(
    reason: Parameters<CompanionManager["ensureForWrite"]>[0],
    suppressedText: string,
    operation: () => Promise<ToolResult>
  ): Promise<ToolResult> {
    const blocked = await ensure(reason, suppressedText);
    if (blocked !== undefined) return blocked;
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof HudClientError) || error.code !== "OFFLINE") {
        return clientFailureResult();
      }
      const recoveryBlocked = await ensure(reason, suppressedText);
      if (recoveryBlocked !== undefined) return recoveryBlocked;
      try {
        return await operation();
      } catch {
        return clientFailureResult();
      }
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
        : `Progress HUD lifecycle failed (${snapshot.code}). Check HUD status or run diagnostics.`;
    return structuredResult(text, payload, !observational && snapshot.code !== undefined);
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
        async () => {
          const snapshot = await client.submit({
            taskId: value.task_id,
            title: value.title,
            event
          });
          return textResult(`Progress recorded: ${snapshot.task?.status ?? "idle"}.`);
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
        async () => {
          const snapshot = await client.submit({
            taskId: value.task_id,
            title: value.title,
            event: {
              type: "model_outcome",
              outcome: value.outcome,
              verified: value.verified,
              ...(value.detail === undefined ? {} : { detail: value.detail })
            }
          });
          return textResult(`Outcome recorded: ${snapshot.task?.status ?? "idle"}.`);
        }
      );
    },

    async taskStatus(): Promise<ToolResult> {
      try {
        const snapshot = await client.status();
        return textResult(JSON.stringify(snapshot));
      } catch {
        return clientFailureResult();
      }
    },

    async trackingStart(input: unknown): Promise<ToolResult> {
      const parsed = trackingStartSchema.safeParse(input ?? {});
      if (!parsed.success) return invalidResult("tracking start");
      return runWrite(
        "tracking_start",
        "HUD is manually closed; tracking was not started.",
        async () => {
          const current = await client.status();
          const taskId = parsed.data.task_id ?? current.task?.id ?? "current";
          const taskTitle = parsed.data.title ?? current.task?.title ?? "当前 Codex 任务";
          const snapshot = await client.submit({
            taskId,
            title: taskTitle,
            event: { type: "tracking_started" }
          });
          return textResult(`Tracking started: ${snapshot.task?.status ?? "idle"}.`);
        }
      );
    },

    async trackingPause(_input?: unknown): Promise<ToolResult> {
      return runWrite(
        "progress_report",
        "HUD is manually closed; tracking was not paused.",
        () => submitForCurrentTask(client, { type: "tracking_paused" })
      );
    },

    async trackingResume(_input?: unknown): Promise<ToolResult> {
      return runWrite(
        "progress_report",
        "HUD is manually closed; tracking was not resumed.",
        () => submitForCurrentTask(client, { type: "tracking_resumed" })
      );
    },

    async trackingStop(_input?: unknown): Promise<ToolResult> {
      return runWrite(
        "progress_report",
        "HUD is manually closed; tracking was not stopped.",
        () => submitForCurrentTask(client, { type: "tracking_stopped" })
      );
    },

    async trackingStatus(): Promise<ToolResult> {
      return this.taskStatus();
    },

    async hudOpen(): Promise<ToolResult> {
      try {
        return lifecycleResult("open", await companionManager.open());
      } catch {
        return structuredResult(
          "Progress HUD could not be opened (INTERNAL_ERROR). Run HUD diagnostics.",
          { ok: false, code: "INTERNAL_ERROR" },
          true
        );
      }
    },

    async hudHide(): Promise<ToolResult> {
      try {
        return lifecycleResult("hidden", await companionManager.hide());
      } catch {
        return structuredResult(
          "Progress HUD could not be hidden (INTERNAL_ERROR). Run HUD diagnostics.",
          { ok: false, code: "INTERNAL_ERROR" },
          true
        );
      }
    },

    async hudClose(): Promise<ToolResult> {
      try {
        return lifecycleResult("closed", await companionManager.close());
      } catch {
        return structuredResult(
          "Progress HUD could not be closed (INTERNAL_ERROR). Run HUD diagnostics.",
          { ok: false, code: "INTERNAL_ERROR" },
          true
        );
      }
    },

    async hudStatus(): Promise<ToolResult> {
      try {
        return lifecycleResult("open", await companionManager.status(), true);
      } catch {
        return structuredResult(
          "Progress HUD status could not be read (INTERNAL_ERROR). Run HUD diagnostics.",
          { ok: false, code: "INTERNAL_ERROR" },
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
      } catch {
        return structuredResult(
          "Progress HUD diagnostics failed (INTERNAL_ERROR).",
          { ok: false, code: "INTERNAL_ERROR" },
          true
        );
      }
    }
  };
}
