import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const names = [`Codex-Progress-HUD-Setup-${pkg.version}.exe`, `codex-progress-hud-plugin-${pkg.version}.zip`].toSorted();
const lines = [];
for (const name of names) {
  const data = await readFile(resolve(root, "release", name));
  lines.push(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
}
await writeFile(resolve(root, "release/SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
