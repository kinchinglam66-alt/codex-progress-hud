import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.CODEX_PROGRESS_HUD_DATA_DIR) {
    return environment.CODEX_PROGRESS_HUD_DATA_DIR;
  }
  if (process.platform === "win32" && environment.APPDATA) {
    return join(environment.APPDATA, "codex-progress-hud");
  }
  if (environment.XDG_CONFIG_HOME) {
    return join(environment.XDG_CONFIG_HOME, "codex-progress-hud");
  }
  return join(homedir(), ".config", "codex-progress-hud");
}

export function defaultTokenPath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.CODEX_PROGRESS_HUD_TOKEN_PATH ?? join(defaultDataDirectory(environment), "auth.token");
}

export function defaultServiceUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.CODEX_PROGRESS_HUD_URL ?? "http://127.0.0.1:17837";
}

