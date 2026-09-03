import { cp, mkdir } from "node:fs/promises";

await Promise.all([
  mkdir("dist/ui", { recursive: true }),
  mkdir("dist/hooks", { recursive: true }),
  mkdir("dist/scripts", { recursive: true })
]);
await Promise.all([
  cp("src/ui/index.html", "dist/ui/index.html"),
  cp("src/ui/styles.css", "dist/ui/styles.css"),
  cp("hooks/hooks.json", "dist/hooks/hooks.json"),
  cp("scripts/launch-hook.ps1", "dist/scripts/launch-hook.ps1")
]);
