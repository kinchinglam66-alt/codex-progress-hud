import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOperationalLogger,
  createOperationalLoggerWithFileSystem,
  type OperationalLogEntry,
  type OperationalLogger
} from "../../src/diagnostics/logger.js";
import { nodeFileSystemOperations } from "../../src/diagnostics/safe-files.js";

const cleanups: Array<() => Promise<void>> = [];

function verifyTypeContract(logger: OperationalLogger): void {
  void logger.write({
    at: "2026-09-02T00:00:00.000Z",
    level: "info",
    event: "startup_requested",
    // @ts-expect-error arbitrary metadata is excluded from the logger interface
    metadata: { taskId: "private" }
  });
}
void verifyTypeContract;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function logDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hud-log-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function ownerAddress(token: string): string {
  return `\\\\.\\pipe\\codex-progress-hud-owner-${token}`;
}

interface HeldOwner {
  address: string;
  server: Server;
}

async function holdLogOwner(): Promise<HeldOwner> {
  const address = ownerAddress(randomUUID());
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  cleanups.push(() => closeLogMutex(server));
  return { address, server };
}

async function closeLogMutex(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function publishLock(directory: string, owner: HeldOwner): Promise<void> {
  const token = randomUUID();
  const tempName = `.companion.log.lock.owner-${token}`;
  const tempPath = join(directory, tempName);
  await writeFile(tempPath, JSON.stringify({ owner: owner.address, tempName, token }));
  await link(tempPath, join(directory, ".companion.log.lock"));
  await rm(tempPath, { force: true });
}

describe("operational logger", () => {
  it("accepts bounded automatic-tracking event codes and persists only code plus timestamp", async () => {
    const directory = await logDirectory();
    const logger = createOperationalLogger({ logDirectory: directory, maxBytes: 256 * 1024, maxFiles: 3 });
    await logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "hook_received" as any,
      payload: "raw prompt/session/title/path secret"
    } as any);

    const content = await readFile(join(directory, "companion.log"), "utf8");
    expect(content).toContain("hook_received");
    expect(content).toContain("2026-09-02T00:00:00.000Z");
    expect(content).not.toContain("raw prompt/session/title/path secret");
  });

  it("serializes only category fields from an entry carrying sensitive extras", async () => {
    const directory = await logDirectory();
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });
    const unsafeEntry = {
      at: "2026-09-02T00:00:00.000Z",
      level: "warn",
      event: "protocol_mismatch",
      lifecycleState: "incompatible",
      protocolVersion: 2,
      httpStatusCategory: "4xx",
      elapsedMs: 27,
      authorization: "Bearer secret",
      query: "token=secret",
      taskId: "task-secret-4312",
      taskTitle: "Confidential release title",
      prompt: "private prompt contents",
      sourcePath: "C:\\Users\\person\\private\\source.ts",
      commandOutput: "private command output",
      environment: { PRIVATE_VALUE: "environment secret" },
      metadata: { arbitrary: "arbitrary metadata" }
    };
    const entry = unsafeEntry as unknown as OperationalLogEntry;

    await logger.write(entry);

    const text = await readFile(join(directory, "companion.log"), "utf8");
    expect(JSON.parse(text.trim())).toEqual({
      at: "2026-09-02T00:00:00.000Z",
      level: "warn",
      event: "protocol_mismatch",
      lifecycleState: "incompatible",
      protocolVersion: 2,
      httpStatusCategory: "4xx",
      elapsedMs: 27
    });
    for (const secret of [
      "Bearer secret",
      "token=secret",
      "task-secret-4312",
      "Confidential release title",
      "private prompt contents",
      "C:\\Users\\person\\private\\source.ts",
      "private command output",
      "environment secret",
      "arbitrary metadata"
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("snapshots each allowed property once before validation", async () => {
    const directory = await logDirectory();
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });
    let eventReads = 0;
    const entry = {
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      get event() {
        eventReads += 1;
        return eventReads === 1 ? "startup_requested" : "Bearer secret";
      }
    } as unknown as OperationalLogEntry;

    await logger.write(entry);

    const text = await readFile(join(directory, "companion.log"), "utf8");
    expect(eventReads).toBe(1);
    expect(JSON.parse(text.trim())).toMatchObject({ event: "startup_requested" });
    expect(text).not.toContain("Bearer secret");
  });

  it("rejects a payload-like value in the event-code field", async () => {
    const directory = await logDirectory();
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });

    await expect(logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "error",
      event: "Bearer secret"
    } as unknown as OperationalLogEntry)).rejects.toThrow("event code");

    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("rejects date-like prose instead of treating it as a timestamp", async () => {
    const directory = await logDirectory();
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });

    await expect(logger.write({
      at: "September 2, 2026",
      level: "info",
      event: "startup_requested"
    })).rejects.toThrow("timestamp");

    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("rotates logs within the configured 256 KiB and file-count bounds", async () => {
    const directory = await logDirectory();
    const maxBytes = 256 * 1024;
    const maxFiles = 3;
    const logger = createOperationalLogger({ logDirectory: directory, maxBytes, maxFiles });

    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(directory, "companion.log"), "x".repeat(maxBytes - 1));
      await logger.write({
        at: "2026-09-02T00:00:00.000Z",
        level: "info",
        event: "startup_requested",
        lifecycleState: "starting",
        protocolVersion: 2,
        elapsedMs: index
      });
    }

    const files = (await readdir(directory)).sort();
    expect(files).toEqual(["companion.log", "companion.log.1", "companion.log.2"]);
    const sizes = await Promise.all(files.map(async (file) => (await stat(join(directory, file))).size));
    expect(sizes.every((size) => size > 0 && size <= maxBytes)).toBe(true);
  }, 20_000);

  it("preserves newest-to-oldest archive ordering during handle rotation", async () => {
    const directory = await logDirectory();
    const maxBytes = 512;
    const activeBefore = `active-before-${"a".repeat(480)}`;
    const archiveOneBefore = "archive-one-before\n";
    const archiveTwoBefore = "archive-two-before\n";
    await writeFile(join(directory, "companion.log"), activeBefore);
    await writeFile(join(directory, "companion.log.1"), archiveOneBefore);
    await writeFile(join(directory, "companion.log.2"), archiveTwoBefore);
    const logger = createOperationalLogger({ logDirectory: directory, maxBytes, maxFiles: 3 });

    await logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    });

    await expect(readFile(join(directory, "companion.log.2"), "utf8")).resolves.toBe(
      archiveOneBefore
    );
    await expect(readFile(join(directory, "companion.log.1"), "utf8")).resolves.toBe(activeBefore);
    await expect(readFile(join(directory, "companion.log"), "utf8")).resolves.toContain(
      "startup_requested"
    );
  });

  it("serializes rotation across two logger instances sharing one directory", async () => {
    const directory = await logDirectory();
    const maxBytes = 512;
    await writeFile(join(directory, "companion.log"), "x".repeat(maxBytes - 1));
    const first = createOperationalLogger({ logDirectory: directory, maxBytes, maxFiles: 3 });
    const second = createOperationalLogger({ logDirectory: directory, maxBytes, maxFiles: 3 });
    const entry: OperationalLogEntry = {
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    };

    await expect(Promise.all([first.write(entry), second.write(entry)])).resolves.toEqual([
      undefined,
      undefined
    ]);

    const files = (await readdir(directory)).filter((file) => file.startsWith("companion.log"));
    const sizes = await Promise.all(files.map(async (file) => (await stat(join(directory, file))).size));
    expect(sizes.every((size) => size <= maxBytes)).toBe(true);
    const contents = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
    expect(contents.join("\n").match(/startup_requested/gu)).toHaveLength(2);
    expect(files).not.toContain("companion.log.lock");
  });

  it("retries when an observed lock disappears before its second path identity check", async () => {
    const directory = await logDirectory();
    const lockPath = join(directory, ".companion.log.lock");
    const owner = await holdLogOwner();
    await publishLock(directory, owner);
    let lockPathStats = 0;
    let disappearedAtSecondCheck = false;
    const logger = createOperationalLoggerWithFileSystem({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    }, {
      ...nodeFileSystemOperations,
      lstatBigInt: async (path) => {
        if (String(path) === lockPath) {
          lockPathStats += 1;
          if (lockPathStats === 2) {
            await rm(lockPath);
            disappearedAtSecondCheck = true;
          }
        }
        return nodeFileSystemOperations.lstatBigInt(path);
      }
    });

    await expect(logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    })).resolves.toBeUndefined();

    expect(disappearedAtSecondCheck).toBe(true);
    await expect(readFile(join(directory, "companion.log"), "utf8")).resolves.toContain(
      "startup_requested"
    );
    expect(await readdir(directory)).not.toContain(".companion.log.lock");
  });

  it("keeps suspended owner initialization invisible until atomic publication", async () => {
    const directory = await logDirectory();
    const token = randomUUID();
    const unpublished = join(directory, `.companion.log.lock.owner-${token}`);
    await writeFile(unpublished, "");
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });

    await logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    });

    await expect(readFile(join(directory, "companion.log"), "utf8")).resolves.toContain(
      "startup_requested"
    );
    await expect(readFile(unpublished, "utf8")).resolves.toBe("");
  });

  it("does not reclaim an atomically published lock from a suspended live owner", async () => {
    const directory = await logDirectory();
    const activePath = join(directory, "companion.log");
    await writeFile(activePath, "existing-category\n");
    const owner = await holdLogOwner();
    await publishLock(directory, owner);
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });

    const writing = logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(readFile(activePath, "utf8")).resolves.toBe("existing-category\n");

    await closeLogMutex(owner.server);
    await writing;
    await expect(readFile(activePath, "utf8")).resolves.toContain("startup_requested");
  });

  it("a late release from an old owner cannot remove its successor lock", async () => {
    const directory = await logDirectory();
    const activePath = join(directory, "companion.log");
    await writeFile(activePath, "existing-category\n");
    const oldOwner = await holdLogOwner();
    await closeLogMutex(oldOwner.server);
    const successor = await holdLogOwner();
    await publishLock(directory, successor);
    await closeLogMutex(oldOwner.server);
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });

    const writing = logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(readFile(activePath, "utf8")).resolves.toBe("existing-category\n");

    await closeLogMutex(successor.server);
    await writing;
    await expect(readFile(activePath, "utf8")).resolves.toContain("startup_requested");
  });

  it("recovers automatically when a lock-owning process crashes", async () => {
    const directory = await logDirectory();
    const ownerToken = randomUUID();
    const crashedOwnerAddress = ownerAddress(ownerToken);
    const script = [
      'const net = require("node:net");',
      'const server = net.createServer((socket) => socket.destroy());',
      'server.listen(process.argv[1], () => process.stdout.write("READY\\n"));'
    ].join("");
    const child = spawn(process.execPath, ["-e", script, crashedOwnerAddress], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const childExited = once(child, "exit");
    cleanups.push(async () => {
      if (child.exitCode !== null) return;
      child.kill();
      await childExited;
    });
    await once(child.stdout!, "data");
    const lockToken = randomUUID();
    const tempName = `.companion.log.lock.owner-${lockToken}`;
    await writeFile(
      join(directory, ".companion.log.lock"),
      JSON.stringify({ owner: crashedOwnerAddress, tempName, token: lockToken })
    );
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });

    const writing = logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "warn",
      event: "crash_recovery"
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readdir(directory)).not.toContain("companion.log");

    child.kill();
    await childExited;
    await writing;
    await expect(readFile(join(directory, "companion.log"), "utf8")).resolves.toContain(
      "crash_recovery"
    );
  });

  it("preserves an older archive when an intermediate archive is absent", async () => {
    const directory = await logDirectory();
    const maxBytes = 512;
    await writeFile(join(directory, "companion.log"), "x".repeat(maxBytes - 1));
    await writeFile(join(directory, "companion.log.2"), "older-retained-category\n");
    const logger = createOperationalLogger({ logDirectory: directory, maxBytes, maxFiles: 3 });

    await logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    });

    await expect(readFile(join(directory, "companion.log.2"), "utf8")).resolves.toBe(
      "older-retained-category\n"
    );
  });

  it("rejects a linked log directory instead of writing through it", async () => {
    const root = await logDirectory();
    const target = join(root, "redirect-target");
    const linked = join(root, "linked-logs");
    await mkdir(target);
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    const logger = createOperationalLogger({
      logDirectory: linked,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });

    await expect(logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    })).rejects.toThrow(/link|trusted directory/iu);

    await expect(readdir(target)).resolves.toEqual([]);
  });

  it("rejects a linked active log file without changing its target", async () => {
    const directory = await logDirectory();
    const target = join(directory, "redirect-target.txt");
    await writeFile(target, "do-not-change");
    await link(target, join(directory, "companion.log"));
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });

    await expect(logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    })).rejects.toThrow(/regular file|link/iu);
    await expect(readFile(target, "utf8")).resolves.toBe("do-not-change");
  });
});
