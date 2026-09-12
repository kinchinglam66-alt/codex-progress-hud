import { cp, mkdir, readdir } from "node:fs/promises";

await Promise.all([
  mkdir("dist/ui", { recursive: true }),
  mkdir("dist/hooks", { recursive: true }),
  mkdir("dist/scripts", { recursive: true }),
  mkdir("dist/estimation/assets", { recursive: true })
]);
// Fail closed on stale/unpinned artifacts; preserve them for inspection instead
// of recursively deleting a build directory that may contain someone else's work.
const estimatorNames=new Set(["instructions.md","estimate.schema.json","observer-instructions.md","observer.schema.json","context-summary-instructions.md","context-summary.schema.json"]);
for(const entry of await readdir("dist/estimation/assets",{withFileTypes:true})) {
  if(!estimatorNames.has(entry.name) || !entry.isFile()) throw new Error("UNEXPECTED_ESTIMATOR_ASSET");
}
await Promise.all([
  cp("src/bootstrap.cjs", "dist/bootstrap.cjs"),
  cp("src/ui/index.html", "dist/ui/index.html"),
  cp("src/ui/styles.css", "dist/ui/styles.css"),
  cp("src/ui/settings.html", "dist/ui/settings.html"),
  cp("src/ui/settings.css", "dist/ui/settings.css"),
  cp("src/ui/settings-preload.cjs", "dist/ui/settings-preload.cjs"),
  cp("hooks/hooks.json", "dist/hooks/hooks.json"),
  cp("scripts/launch-hook.ps1", "dist/scripts/launch-hook.ps1"),
  cp("src/estimation/assets/instructions.md", "dist/estimation/assets/instructions.md"),
  cp("src/estimation/assets/estimate.schema.json", "dist/estimation/assets/estimate.schema.json"),
  cp("src/estimation/assets/observer-instructions.md", "dist/estimation/assets/observer-instructions.md"),
  cp("src/estimation/assets/observer.schema.json", "dist/estimation/assets/observer.schema.json"),
  cp("src/estimation/assets/context-summary-instructions.md", "dist/estimation/assets/context-summary-instructions.md"),
  cp("src/estimation/assets/context-summary.schema.json", "dist/estimation/assets/context-summary.schema.json")
]);
