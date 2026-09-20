import { homedir } from "node:os";
import { join } from "node:path";

/** Main task source, never the independently authenticated observer profile. */
export function defaultCodexSessionsRoot(environment:NodeJS.ProcessEnv=process.env):string {
  return join(environment.CODEX_HOME || join(homedir(),'.codex'),'sessions');
}

export function defaultDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.CODEX_PROGRESS_HUD_DATA_DIR) {
    return environment.CODEX_PROGRESS_HUD_DATA_DIR;
  }
  if (process.platform === "win32") {
    // AppData is virtualized for children of an MSIX host. Use a per-user
    // location outside that overlay so Explorer, MCP and hooks share state.
    return join(environment.USERPROFILE || homedir(), ".codex-progress-hud");
  }
  if (environment.XDG_CONFIG_HOME) {
    return join(environment.XDG_CONFIG_HOME, "codex-progress-hud");
  }
  return join(homedir(), ".config", "codex-progress-hud");
}

export function defaultTokenPath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.CODEX_PROGRESS_HUD_TOKEN_PATH ?? join(defaultDataDirectory(environment), "auth.token");
}

export function defaultSettingsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(defaultDataDirectory(environment), "settings.json");
}

export function defaultRuntimePath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(defaultDataDirectory(environment), "runtime.json");
}

export function defaultInstallManifestPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(defaultDataDirectory(environment), "install.json");
}

export function defaultLogDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(defaultDataDirectory(environment), "logs");
}

export function defaultDiagnosticsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(defaultDataDirectory(environment), "diagnostics");
}

export function defaultServiceUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.CODEX_PROGRESS_HUD_URL ?? "http://127.0.0.1:17837";
}
