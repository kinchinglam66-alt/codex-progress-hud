import { pathToFileURL } from "node:url";

export type EntryMode = "hud" | "mcp-stdio";
export type DesktopLaunchReason =
  | { kind: "explicit" }
  | { kind: "automatic-login" }
  | { kind: "manager"; generation: number };

export type EntryIntent =
  | { mode: "mcp-stdio" }
  | { mode: "hud"; launchReason: "explicit" | "automatic-login" }
  | { mode: "hud"; launchReason: "manager"; generation: number };

const MANAGER_GENERATION_PREFIX = "--manager-generation";

export function selectEntryIntent(argv: string[]): EntryIntent {
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
      argv.includes("--mcp-stdio") ||
      argv.includes("--automatic-login")
    ) {
      throw new Error("Invalid manager launch arguments");
    }
    return { mode: "hud", launchReason: "manager", generation };
  }
  if (argv.includes("--mcp-stdio")) return { mode: "mcp-stdio" };
  return {
    mode: "hud",
    launchReason: argv.includes("--automatic-login") ? "automatic-login" : "explicit"
  };
}

export function selectEntryMode(argv: string[]): EntryMode {
  return selectEntryIntent(argv).mode;
}

async function runSelectedMode(argv: string[]): Promise<void> {
  const intent = selectEntryIntent(argv);
  if (intent.mode === "mcp-stdio") {
    const { runMcpServer } = await import("./mcp/main.js");
    await runMcpServer();
    return;
  }

  const { runDesktop } = await import("./desktop/main.js");
  const launchReason: DesktopLaunchReason = intent.launchReason === "manager"
    ? { kind: "manager", generation: intent.generation }
    : { kind: intent.launchReason };
  await runDesktop(undefined, launchReason);
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
