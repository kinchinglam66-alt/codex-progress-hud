import { pathToFileURL } from "node:url";

export type EntryMode = "hud" | "mcp-stdio";
export type DesktopLaunchReason = "explicit" | "automatic-login";

export type EntryIntent =
  | { mode: "mcp-stdio" }
  | { mode: "hud"; launchReason: DesktopLaunchReason };

export function selectEntryIntent(argv: string[]): EntryIntent {
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
