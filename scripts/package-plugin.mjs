import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const files = [
  ".codex-plugin/plugin.json", ".mcp.json", "hooks/hooks.json",
  "skills/progress-reporting/SKILL.md", "scripts/codex-progress-hud-launcher.exe", "scripts/invoke-node-mode.ps1", "scripts/launch-hook.ps1", "scripts/launch-mcp.ps1",
  "README.md", "LICENSE", "NOTICE", "PRIVACY.md", "SECURITY.md"
].toSorted();
const epoch = new Date(Number(process.env.SOURCE_DATE_EPOCH ?? 1_788_220_800) * 1000);
const dosYear = Math.max(1980, epoch.getUTCFullYear());
const dosDate = ((dosYear - 1980) << 9) | ((epoch.getUTCMonth() + 1) << 5) | epoch.getUTCDate();
const dosTime = (epoch.getUTCHours() << 11) | (epoch.getUTCMinutes() << 5) | Math.floor(epoch.getUTCSeconds() / 2);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const local = [];
const central = [];
let offset = 0;
for (const name of files) {
  const data = await readFile(resolve(root, "plugins/codex-progress-hud", name));
  const encodedName = Buffer.from(name.replaceAll("\\", "/"), "utf8");
  const checksum = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8); header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(encodedName.length, 26); header.writeUInt16LE(0, 28);
  local.push(header, encodedName, data);

  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(0, 10); directory.writeUInt16LE(dosTime, 12);
  directory.writeUInt16LE(dosDate, 14); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(data.length, 20);
  directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(encodedName.length, 28);
  directory.writeUInt32LE(offset, 42);
  central.push(directory, encodedName);
  offset += header.length + encodedName.length + data.length;
}
const centralSize = central.reduce((sum, item) => sum + item.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
const output = resolve(root, `release/codex-progress-hud-plugin-${pkg.version}.zip`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([...local, ...central, end]));
process.stdout.write(`${output}\n`);
