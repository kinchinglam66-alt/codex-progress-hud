import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { metricsSchema } from "./contracts.js";
import { packObserverInput } from './observer-input.js';
import type { Invocation } from "./owned-process.js";
import {supportedCodexVersion} from './codex-runtime-profiles.js';

const disabled = ["plugins", "hooks", "apps", "remote_plugin", "multi_agent", "shell_tool", "unified_exec",
  "shell_snapshot", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "computer_use", "image_generation", "view_image", "skill_search", "workspace_dependencies",
  "code_mode_host", "memories", "sleep_tool", "in_app_browser"] as const;
// Parent-controlled platform/login locations and proxy/trust settings only.
// No ambient service credentials, dynamic-loader overrides or logging controls.
const allowedEnv = new Set(["SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "CODEX_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "LANG", "LC_ALL", "TZ"]);

export interface CodexProfile {
  executable: string;
  cwd: string;
  schemaPath: string;
  instructionsPath: string;
  compressionSchemaPath?: string;
  compressionInstructionsPath?: string;
  version: string;
  features: readonly string[];
}

export function subscriptionEnvironment(env:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowedEnv.has(key.toUpperCase())));
}

/** Pure internal builder, NOT executable discovery or authentication attestation.
 * A future trusted preflight must verify the executable, empty cwd, packaged
 * assets and actual capability evidence. Never accept this profile from tasks.
 * The exact version gate reflects the tested Windows system-proxy profile.
 */
type ObserverSetupAction = 'login' | 'status' | 'metadata' | 'logout' | 'device-auth';

function buildInvocation(profile: CodexProfile, input: string, env: NodeJS.ProcessEnv, mode: 'exec' | ObserverSetupAction = 'exec', assets?: {schemaPath: string; instructionsPath: string}): Invocation {
  const schemaPath = assets?.schemaPath ?? profile.schemaPath;
  const instructionsPath = assets?.instructionsPath ?? profile.instructionsPath;
  if (!supportedCodexVersion(profile.version) ||
    [profile.executable, profile.cwd, schemaPath, instructionsPath].some(
      path => typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) ||
    !Array.isArray(profile.features) ||
    [...disabled, "skip_host_skill_discovery", "respect_system_proxy"].some(feature => !profile.features.includes(feature))) {
    throw new Error("UNSUPPORTED_CODEX_PROFILE");
  }
  const args = mode === 'exec' ? ["exec", "--ignore-user-config", "--strict-config", "--ephemeral", "--skip-git-repo-check",
    "--sandbox", "read-only", "--model", "gpt-5.6-luna", "--color", "never", "--json",
    "--output-schema", schemaPath, "--cd", profile.cwd] : mode === 'login' ? ['login'] :
    mode === 'device-auth' ? ['login', '--device-auth'] : mode === 'logout' ? ['logout'] :
    mode === 'status' ? ['login', 'status'] : ['app-server', '--stdio', '--strict-config'];
  for (const feature of disabled) args.push("--disable", feature);
  const config = {
    forced_login_method:"chatgpt", model_provider:"openai", model_reasoning_effort:"medium",
    approval_policy:"never", web_search:"disabled", project_doc_max_bytes:0,
    "history.persistence":"none", hide_agent_reasoning:true, "analytics.enabled":false,
    "features.skip_host_skill_discovery":true, suppress_unstable_features_warning:true,
    model_instructions_file:instructionsPath, "features.respect_system_proxy":true
  };
  for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${JSON.stringify(value)}`);
  if (mode === 'exec') args.push("-");
  else args.push('-c', 'cli_auth_credentials_store="file"');
  const childEnv = subscriptionEnvironment(env);
  return {executable:profile.executable, cwd:profile.cwd, args, env:childEnv, input};
}

export function buildCodexInvocation(profile: CodexProfile, metrics: unknown, env: NodeJS.ProcessEnv): Invocation {
  const parsed = metricsSchema.safeParse(metrics);
  if (!parsed.success) throw new Error('INVALID_ESTIMATION_METRICS');
  return buildInvocation(profile, JSON.stringify(parsed.data), env);
}

/** Profile and observer schema/instruction paths must be supplied by trusted preflight,
 * never task input. Preparing an invocation does not launch or authorize it.
 */
export function buildObserverCodexInvocation(profile: CodexProfile, input: unknown, env: NodeJS.ProcessEnv, observerHome?: string): Invocation {
  const packed = packObserverInput(input);
  const invocation = buildInvocation(profile, packed, observerEnvironment(env, observerHome));
  return {...invocation, args: [...invocation.args.slice(0, -1), '-c', 'cli_auth_credentials_store="file"', '-']};
}

/** Uses only compression asset paths carried through trusted preflight. The
 * request text is data supplied on stdin; it cannot select files or tools. */
export function buildObserverCompressionInvocation(profile: CodexProfile, input: string, env: NodeJS.ProcessEnv, observerHome?: string): Invocation {
  if (typeof profile.compressionSchemaPath !== 'string' || typeof profile.compressionInstructionsPath !== 'string') {
    throw new Error('OBSERVER_COMPRESSION_ASSETS_REQUIRED');
  }
  const invocation = buildInvocation(profile, input, observerEnvironment(env, observerHome), 'exec', {
    schemaPath: profile.compressionSchemaPath, instructionsPath: profile.compressionInstructionsPath,
  });
  return {...invocation, args: [...invocation.args.slice(0, -1), '-c', 'cli_auth_credentials_store="file"', '-']};
}

export function resolveObserverAuthHome(env: NodeJS.ProcessEnv, observerHome?: string): string {
  // This lexical guard is not filesystem ownership/ACL/reparse attestation.
  // The trusted caller must verify the companion directory before every spawn.
  if (typeof observerHome !== 'string' || !isAbsolute(observerHome) ||
      /[\x00-\x1f\x7f]/.test(observerHome) ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(observerHome))) {
    throw new Error('OBSERVER_AUTH_HOME_REQUIRED');
  }
  const home = resolve(observerHome);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  };
  const inheritedHomes = Object.entries(env).flatMap(([key, value]) => {
    if (!value) return [];
    if (key.toUpperCase() === 'CODEX_HOME') return [resolve(value)];
    if (['HOME', 'USERPROFILE'].includes(key.toUpperCase())) return [resolve(value, '.codex')];
    return [];
  });
  if (home === parse(home).root || inheritedHomes.some(main => contains(main, home) || contains(home, main))) {
    throw new Error('OBSERVER_AUTH_HOME_REQUIRED');
  }
  return home;
}

function observerEnvironment(env: NodeJS.ProcessEnv, observerHome?: string): NodeJS.ProcessEnv {
  const home = resolveObserverAuthHome(env, observerHome);
  const isolatedEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'CODEX_HOME'));
  isolatedEnv.CODEX_HOME = home;
  return isolatedEnv;
}

/** Builds only. The owner must attest filesystem/config/assets first, then manage
 * interactive login or the metadata protocol and cancellation. No implicit spawn. */
export function buildObserverSetupInvocation(profile: CodexProfile, action: ObserverSetupAction, env: NodeJS.ProcessEnv, observerHome?: string): Invocation {
  if (!['login', 'status', 'metadata', 'logout', 'device-auth'].includes(action)) throw new Error('INVALID_OBSERVER_SETUP_ACTION');
  return buildInvocation(profile, '', observerEnvironment(env, observerHome), action);
}
