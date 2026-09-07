import type { CompanionManager } from "../lifecycle/companion-manager.js";
import type { HudSettings, StateOperationOptions } from "../lifecycle/types.js";
import { createLifecycleStateStore } from "../lifecycle/state-store.js";
import { defaultInstallManifestPath, defaultRuntimePath, defaultSettingsPath } from "../server/paths.js";
import { CompanionHttpClient, type HudRequestOptions } from "../mcp/report-client.js";
import type { HookEnvelope } from "./schema.js";

export interface HookProgressClient {
  status(options?: HudRequestOptions): Promise<{ revision: number }>;
  submitHook(envelope: HookEnvelope, options?: HudRequestOptions): Promise<unknown>;
}

export interface HookEventClient {
  post(envelope: HookEnvelope, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
}

export class HookDeliveryError extends Error {
  constructor(readonly code: string) {
    super("Hook delivery did not complete");
    this.name = "HookDeliveryError";
  }
}

export interface HookClientDependencies {
  progressClient: HookProgressClient;
  companionManager: Pick<CompanionManager, "executeWrite">;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function createHookClient(dependencies: HookClientDependencies): HookEventClient {
  return {
    async post(envelope, options = {}): Promise<void> {
      const result = await dependencies.companionManager.executeWrite("progress_report", async (makeRequestOptions) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const requestOptions = makeRequestOptions();
          const current = await dependencies.progressClient.status(requestOptions);
          if (requestOptions.signal.aborted) throw requestOptions.signal.reason;
          try {
            await dependencies.progressClient.submitHook(envelope, {
              ...requestOptions,
              revision: current.revision
            });
            return;
          } catch (error) {
            if (attempt === 0 && errorCode(error) === "STALE_REVISION") continue;
            throw error;
          }
        }
      }, options);
      if (result.kind !== "completed") throw new HookDeliveryError(result.code);
    }
  };
}

export function createConnectedHookClient(dependencies: {
  progressClient: HookProgressClient;
  readSettings(options?: StateOperationOptions): Promise<HudSettings>;
}): HookEventClient {
  return createHookClient({
    progressClient: dependencies.progressClient,
    companionManager: {
      async executeWrite(_reason, operation, options = {}) {
        const settings = await dependencies.readSettings(options);
        if (settings.desiredState === "off") return { kind: "suppressed", code: "MANUALLY_DISABLED" };
        const signal = options.signal ?? new AbortController().signal;
        if (signal.aborted) throw signal.reason;
        const deadline = Date.now() + (options.timeoutMs ?? 2500);
        const value = await operation(() => ({
          signal, generation: settings.generation,
          timeoutMs: Math.max(0, deadline - Date.now())
        }));
        return { kind: "completed", value };
      }
    }
  });
}

export function createDefaultHookClient(): HookEventClient {
  const store = createLifecycleStateStore({
    settingsPath: defaultSettingsPath(), runtimePath: defaultRuntimePath(),
    installManifestPath: defaultInstallManifestPath()
  });
  return createConnectedHookClient({ progressClient: new CompanionHttpClient(), readSettings: store.readSettings });
}
