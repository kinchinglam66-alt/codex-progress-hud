import { pathToFileURL } from "node:url";

export type EntryMode = "hud" | "mcp-stdio";

export function selectEntryMode(argv: string[]): EntryMode {
  return argv.includes("--mcp-stdio") ? "mcp-stdio" : "hud";
}

async function runSelectedMode(argv: string[]): Promise<void> {
  if (selectEntryMode(argv) === "mcp-stdio") {
    const { runMcpServer } = await import("./mcp/main.js");
    await runMcpServer();
    return;
  }

  const { runDesktop } = await import("./desktop/main.js");
  await runDesktop();
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
