import { spawn } from "node:child_process";

export interface HeldLifecycleLock {
  release(): Promise<void>;
  releaseWithWrites(writes: Array<{ path: string; content: string }>): Promise<void>;
}

const holderScript = String.raw`
const { link, unlink, writeFile } = require("node:fs/promises");

const lockPath = process.argv[1];
const token = "test-lock-holder";
const ownerPath = lockPath + ".owner-" + process.pid + "-" + token;

async function remove(path) {
  await unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function release() {
  await remove(lockPath);
  await remove(ownerPath);
}

(async () => {
  await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }) + "\n", {
    flag: "wx",
    mode: 0o600
  });
  await link(ownerPath, lockPath);
  process.stdout.write("ready\n");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.once("end", async () => {
    const command = JSON.parse(input || "{}");
    for (const write of command.writes || []) {
      await writeFile(write.path, write.content);
    }
    await release();
    process.exit(0);
  });
  process.stdin.resume();
})().catch((error) => {
  process.stderr.write(String(error));
  process.exit(1);
});
`;

export async function holdLifecycleLock(lockPath: string): Promise<HeldLifecycleLock> {
  const child = spawn(process.execPath, ["-e", holderScript, lockPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lock holder did not become ready")), 2_000);
    const ready = (chunk: string) => {
      if (!chunk.includes("ready\n")) return;
      clearTimeout(timer);
      child.off("exit", exited);
      resolve();
    };
    const exited = (code: number | null) => {
      clearTimeout(timer);
      child.stdout.off("data", ready);
      reject(new Error(`lock holder exited ${code}: ${stderr || stdout}`));
    };
    child.stdout.on("data", ready);
    child.once("exit", exited);
  });

  let released = false;
  const finish = async (writes: Array<{ path: string; content: string }>) => {
    if (released) return;
    released = true;
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`lock holder exited ${code}: ${stderr || stdout}`));
      });
    });
    child.stdin.end(JSON.stringify({ writes }));
    await exited;
  };
  return {
    release: () => finish([]),
    releaseWithWrites: (writes) => finish(writes)
  };
}
