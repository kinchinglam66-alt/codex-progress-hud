import { runDesktop } from "./lifecycle.js";

void runDesktop().catch((error) => {
  console.error("Codex Progress HUD failed to start", error);
  process.exitCode = 1;
});
