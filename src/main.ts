import { pathToFileURL } from "node:url";
import { hookNames, type HookName } from "./hooks/schema.js";

export type EntryMode = "hud" | "mcp-stdio" | "hook-event";
export type DesktopLaunchReason =
  | { kind: "explicit" }
  | { kind: "manager"; generation: number };

export type EntryIntent =
  | { mode: "mcp-stdio" }
  | { mode: "hud"; launchReason: DesktopLaunchReason }
  | { mode: "hook-event"; hookName: HookName };

const MANAGER_GENERATION_PREFIX = "--manager-generation";

export function selectEntryIntent(argv: string[]): EntryIntent {
  const hookArguments = argv.filter((argument) => argument.startsWith("--hook-event"));
  if (hookArguments.length > 0) {
    if (
      hookArguments.length !== 1 ||
      !/^--hook-event=(?:SessionStart|UserPromptSubmit|PostToolUse|Stop|Interrupt|SessionEnd)$/u.test(hookArguments[0]!) ||
      argv.includes("--mcp-stdio") ||
      argv.includes("--hud") ||
      argv.includes("--automatic-login") ||
      argv.some((argument) => argument.startsWith(`${MANAGER_GENERATION_PREFIX}`))
    ) {
      throw new Error("Invalid hook event arguments");
    }
    const hookName = hookArguments[0]!.slice("--hook-event=".length) as HookName;
    if (!hookNames.includes(hookName)) throw new Error("Invalid hook event arguments");
    return { mode: "hook-event", hookName };
  }
  if (argv.includes("--automatic-login")) {
    throw new Error("Automatic login is disabled");
  }
  const managerArguments = argv.filter(
    (argument) =>
      argument === MANAGER_GENERATION_PREFIX ||
      argument.startsWith(`${MANAGER_GENERATION_PREFIX}=`)
  );
  if (managerArguments.length > 1) throw new Error("Invalid manager generation");
  if (managerArguments.length === 1) {
    const match = /^--manager-generation=(\d+)$/u.exec(managerArguments[0]!);
    const generation = match === null ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(generation)) throw new Error("Invalid manager generation");
    if (
      !argv.includes("--hud") ||
      argv.includes("--mcp-stdio")
    ) {
      throw new Error("Invalid manager launch arguments");
    }
    return { mode: "hud", launchReason: { kind: "manager", generation } };
  }
  if (argv.includes("--mcp-stdio")) return { mode: "mcp-stdio" };
  return {
    mode: "hud",
    launchReason: { kind: "explicit" }
  };
}

export function selectEntryMode(argv: string[]): EntryMode {
  return selectEntryIntent(argv).mode;
}

async function runSelectedMode(argv: string[]): Promise<void> {
  const intent = selectEntryIntent(argv);
  if (intent.mode === "hook-event") {
    const { runHookEvent } = await import("./hooks/main.js");
    await runHookEvent(intent.hookName);
    return;
  }
  if (intent.mode === "mcp-stdio") {
    const { runMcpServer } = await import("./mcp/main.js");
    await runMcpServer();
    return;
  }

  const { runDesktop } = await import("./desktop/main.js");
  await runDesktop(undefined, intent.launchReason);
}

function isExecutableEntry(): boolean {
  if (process.versions.electron) return true;
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
}

if (isExecutableEntry()) {
  void runSelectedMode(process.argv).catch((error: unknown) => {
    console.error("Codex Progress HUD failed to start", error);
    process.exitCode = 1;
  });
}
