import { createCompanionManager, type CompanionManager } from "../lifecycle/companion-manager.js";
import { processLauncher } from "../lifecycle/process-launcher.js";
import { createLifecycleStateStore } from "../lifecycle/state-store.js";
import { defaultDataDirectory, defaultDiagnosticsDirectory, defaultInstallManifestPath, defaultRuntimePath, defaultServiceUrl, defaultSettingsPath } from "../server/paths.js";
import { CompanionHttpClient, type HudRequestOptions } from "../mcp/report-client.js";
import type { HookEnvelope } from "./schema.js";

export interface HookProgressClient {
  status(options?: HudRequestOptions): Promise<{ revision: number }>;
  submitHook(envelope: HookEnvelope, options?: HudRequestOptions): Promise<unknown>;
}

export interface HookEventClient {
  post(envelope: HookEnvelope, signal?: AbortSignal): Promise<void>;
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
    async post(envelope, signal): Promise<void> {
      await dependencies.companionManager.executeWrite("progress_report", async (makeRequestOptions) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const requestOptions = makeRequestOptions();
          if (signal?.aborted) throw signal.reason;
          const current = await dependencies.progressClient.status(requestOptions);
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
      });
    }
  };
}

export function createDefaultHookClient(): HookEventClient {
  const version = "0.1.0";
  const progressClient = new CompanionHttpClient();
  const serviceUrl = new URL(defaultServiceUrl());
  const companionManager = createCompanionManager({
    store: createLifecycleStateStore({
      settingsPath: defaultSettingsPath(),
      runtimePath: defaultRuntimePath(),
      installManifestPath: defaultInstallManifestPath()
    }),
    client: progressClient,
    launcher: processLauncher,
    diagnostics: {
      directory: defaultDiagnosticsDirectory(),
      pluginVersion: version,
      mcpVersion: version,
      host: serviceUrl.hostname,
      port: Number(serviceUrl.port || (serviceUrl.protocol === "https:" ? 443 : 80)),
      installManifestPath: defaultInstallManifestPath(),
      dataDirectoryPath: defaultDataDirectory()
    }
  });
  return createHookClient({ progressClient, companionManager });
}
