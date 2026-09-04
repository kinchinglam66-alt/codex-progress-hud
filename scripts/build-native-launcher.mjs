import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  process.stdout.write("Native launcher build is Windows-only; using the checked-in release binary.\n");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "plugins/codex-progress-hud/scripts/codex-progress-hud-launcher.exe");
const source = resolve(root, "build/native-launcher.cs");
const sourceStamp = resolve(root, "build/native-launcher.source.sha256");
const sourceHash = createHash("sha256").update(await readFile(source)).digest("hex");
const recordedHash = await readFile(sourceStamp, "utf8").catch(() => "");
const outputExists = await access(output).then(() => true, () => false);
if (!process.argv.includes("--force") && outputExists && recordedHash.trim() === sourceHash) {
  process.stdout.write(`Native launcher is current: ${output}\n`);
  process.exit(0);
}
const compiler = resolve(process.env.WINDIR ?? "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
await mkdir(dirname(output), { recursive: true });
const result = spawnSync(compiler, [
  "/nologo", "/optimize+", "/target:exe", "/reference:System.Web.Extensions.dll",
  `/out:${output}`, source
], { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`native launcher compiler exited with ${result.status}`);
await writeFile(sourceStamp, `${sourceHash}\n`, "utf8");
process.stdout.write(`${output}\n`);
