import * as actualFs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nodeFileSystemOperations,
  type FileSystemOperations
} from "../../src/diagnostics/safe-files.js";
import { createOperationalLoggerWithFileSystem } from "../../src/diagnostics/logger.js";
import {
  createDiagnosticReportWriter,
  type DiagnosticReportInput
} from "../../src/diagnostics/report.js";

const race = {
  beforeOpen: undefined as undefined | ((path: string) => Promise<boolean>),
  beforeMutation: undefined as undefined | ((kind: string, path: string) => Promise<boolean>),
  openCalls: 0,
  lockCollision: undefined as undefined | {
    published: boolean;
    ownerStats: number;
  }
};

const COLLIDING_IDENTITIES = {
  path: { dev: 1_152_921_504_606_846_976n, ino: 2_305_843_009_213_693_952n },
  handle: { dev: 1_152_921_504_606_846_977n, ino: 2_305_843_009_213_693_953n },
  ownerRecord: { dev: 1_152_921_504_606_846_978n, ino: 2_305_843_009_213_693_954n },
  ownerCurrent: { dev: 1_152_921_504_606_846_979n, ino: 2_305_843_009_213_693_955n }
} as const;

function withIdentity(
  information: BigIntStats,
  identity: { readonly dev: bigint; readonly ino: bigint }
): BigIntStats {
  return new Proxy(information, {
    get(target, property) {
      if (property === "dev" || property === "ino") return identity[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

const injectedFileSystem: FileSystemOperations = {
  ...nodeFileSystemOperations,
  lstatBigInt: async (path) => {
    const information = await nodeFileSystemOperations.lstatBigInt(path);
    const collision = race.lockCollision;
    const text = String(path);
    if (collision === undefined) return information;
    if (text.endsWith(".companion.log.lock")) {
      collision.published = true;
      return withIdentity(information, COLLIDING_IDENTITIES.path);
    }
    if (collision.published && text.includes(".companion.log.lock.owner-")) {
      collision.ownerStats += 1;
      const identity = collision.ownerStats === 1
        ? COLLIDING_IDENTITIES.ownerRecord
        : COLLIDING_IDENTITIES.ownerCurrent;
      return withIdentity(information, identity);
    }
    return information;
  },
  open: async (...arguments_: Parameters<typeof nodeFileSystemOperations.open>) => {
    race.openCalls += 1;
    const path = String(arguments_[0]);
    const beforeOpen = race.beforeOpen;
    if (beforeOpen !== undefined) {
      if (await beforeOpen(path)) race.beforeOpen = undefined;
    }
    const handle = await nodeFileSystemOperations.open(...arguments_);
    return new Proxy(handle, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "stat" && typeof value === "function") {
          return async (...methodArguments: unknown[]) => {
            const information = await Reflect.apply(value, target, methodArguments);
            if (
              race.lockCollision !== undefined &&
              path.endsWith(".companion.log.lock") &&
              (methodArguments[0] as { bigint?: boolean } | undefined)?.bigint === true
            ) {
              return withIdentity(information as BigIntStats, COLLIDING_IDENTITIES.handle);
            }
            return information;
          };
        }
        if ((property === "truncate" || property === "write") && typeof value === "function") {
          return async (...methodArguments: unknown[]) => {
            const beforeMutation = race.beforeMutation;
            if (
              beforeMutation !== undefined &&
              await beforeMutation(String(property), path)
            ) {
              race.beforeMutation = undefined;
            }
            return Reflect.apply(value, target, methodArguments);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }
};

const writeDiagnosticReport = createDiagnosticReportWriter(injectedFileSystem);

function createOperationalLogger(
  options: Parameters<typeof createOperationalLoggerWithFileSystem>[0]
) {
  return createOperationalLoggerWithFileSystem(options, injectedFileSystem);
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  race.beforeOpen = undefined;
  race.beforeMutation = undefined;
  race.openCalls = 0;
  race.lockCollision = undefined;
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function replaceDirectory(directory: string, parked: string, outside: string): Promise<void> {
  await actualFs.rename(directory, parked);
  await actualFs.rename(outside, directory);
}

async function textOrMissing(path: string): Promise<string> {
  try {
    return await actualFs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "MISSING";
    throw error;
  }
}

function reportInput(directory: string): DiagnosticReportInput {
  return {
    directory,
    generatedAt: "2026-09-02T00:00:00.000Z",
    versions: { plugin: "0.2.0", mcp: "0.2.0", protocol: 1 },
    lifecycle: { desiredState: "on", observedState: "running" },
    paths: { installManifestExists: true, dataDirectoryExists: true },
    endpoint: { host: "127.0.0.1", port: 17_837 },
    errors: []
  };
}

describe("diagnostic output race defenses", () => {
  it("rejects lock and owner files whose distinct bigint identities collide as numbers", async () => {
    const directory = await actualFs.mkdtemp(join(tmpdir(), "hud-lock-identity-collision-"));
    cleanups.push(() => actualFs.rm(directory, { recursive: true, force: true }));
    race.lockCollision = { published: false, ownerStats: 0 };
    const numericIdentities = Object.values(COLLIDING_IDENTITIES).map(({ dev, ino }) => [
      Number(dev),
      Number(ino)
    ]);
    expect(new Set(numericIdentities.map(([dev]) => dev))).toHaveLength(1);
    expect(new Set(numericIdentities.map(([, ino]) => ino))).toHaveLength(1);
    expect(new Set(Object.values(COLLIDING_IDENTITIES).map(({ dev }) => dev))).toHaveLength(4);
    expect(new Set(Object.values(COLLIDING_IDENTITIES).map(({ ino }) => ino))).toHaveLength(4);
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });

    await expect(logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    })).rejects.toThrow(/lock changed|lock path changed/iu);

    const files = await actualFs.readdir(directory);
    expect(files.some((file) => file.startsWith(".companion.log.lock.owner-"))).toBe(true);
    expect(files).not.toContain("companion.log");
  });

  it("rejects a directory substitution before report content is written", async () => {
    const root = await actualFs.mkdtemp(join(tmpdir(), "hud-output-swap-"));
    cleanups.push(() => actualFs.rm(root, { recursive: true, force: true }));
    const directory = join(root, "reports");
    const parked = join(root, "reports-parked");
    const outside = join(root, "outside");
    await actualFs.mkdir(directory);
    await actualFs.mkdir(outside);
    const directoryIdentity = await nodeFileSystemOperations.lstatBigInt(directory);
    const outsideIdentity = await nodeFileSystemOperations.lstatBigInt(outside);
    expect(directoryIdentity.ino).not.toBe(outsideIdentity.ino);
    race.beforeOpen = async (path) => {
      if (!path.endsWith(".md")) return false;
      await replaceDirectory(directory, parked, outside);
      return true;
    };

    await expect(writeDiagnosticReport(reportInput(directory))).rejects.toThrow(
      /changed|trusted directory/iu
    );
    expect(race.openCalls).toBeGreaterThan(0);

    const outsideFiles = await actualFs.readdir(directory);
    for (const file of outsideFiles) {
      await expect(actualFs.readFile(join(directory, file), "utf8")).resolves.toBe("");
    }
  });

  it("rejects a hard link created after the log precheck and before handle validation", async () => {
    const directory = await actualFs.mkdtemp(join(tmpdir(), "hud-output-hardlink-race-"));
    cleanups.push(() => actualFs.rm(directory, { recursive: true, force: true }));
    const active = join(directory, "companion.log");
    const linked = join(directory, "captured.log");
    await actualFs.writeFile(active, "");
    race.beforeOpen = async (path) => {
      if (!path.endsWith("companion.log")) return false;
      await actualFs.link(path, linked);
      return true;
    };
    const logger = createOperationalLogger({
      logDirectory: directory,
      maxBytes: 256 * 1024,
      maxFiles: 3
    });

    await expect(logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    })).rejects.toThrow("diagnostic output file must have one link");
    expect(race.openCalls).toBeGreaterThan(0);
    await expect(actualFs.readFile(linked, "utf8")).resolves.toBe("");
  });

  it("does not delete an outside archive when the directory swaps at replacement", async () => {
    const root = await actualFs.mkdtemp(join(tmpdir(), "hud-rotation-remove-swap-"));
    cleanups.push(() => actualFs.rm(root, { recursive: true, force: true }));
    const directory = join(root, "logs");
    const outside = join(root, "outside");
    await actualFs.mkdir(directory);
    await actualFs.mkdir(outside);
    await actualFs.writeFile(join(directory, "companion.log"), "x".repeat(255));
    await actualFs.writeFile(join(directory, "companion.log.1"), "newer-category\n");
    await actualFs.writeFile(join(directory, "companion.log.2"), "older-category\n");
    await actualFs.writeFile(join(outside, "companion.log.2"), "outside-victim\n");
    let swapped = false;
    race.beforeMutation = async (kind, path) => {
      if (kind === "rm" && path.endsWith("companion.log.2")) {
        await actualFs.rm(join(outside, "companion.log.2"), { force: true });
        swapped = true;
        return true;
      }
      if (kind === "truncate" && path.endsWith("companion.log.2")) {
        swapped = true;
        return true;
      }
      return false;
    };
    const logger = createOperationalLogger({ logDirectory: directory, maxBytes: 256, maxFiles: 3 });

    await logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    }).catch(() => undefined);
    const outsideVictim = await textOrMissing(join(outside, "companion.log.2"));
    expect(swapped).toBe(true);
    expect(outsideVictim).toBe("outside-victim\n");
  });

  it("does not move an outside archive when the directory swaps at archive copy", async () => {
    const root = await actualFs.mkdtemp(join(tmpdir(), "hud-rotation-move-swap-"));
    cleanups.push(() => actualFs.rm(root, { recursive: true, force: true }));
    const directory = join(root, "logs");
    const outside = join(root, "outside");
    await actualFs.mkdir(directory);
    await actualFs.mkdir(outside);
    await actualFs.writeFile(join(directory, "companion.log"), "x".repeat(255));
    await actualFs.writeFile(join(directory, "companion.log.1"), "newer-category\n");
    await actualFs.writeFile(join(directory, "companion.log.2"), "older-category\n");
    await actualFs.writeFile(join(outside, "companion.log.1"), "outside-source-victim\n");
    let swapped = false;
    race.beforeMutation = async (kind, path) => {
      if (kind === "rename" && path.endsWith("companion.log.2")) {
        await actualFs.rename(
          join(outside, "companion.log.1"),
          join(outside, "companion.log.2")
        );
        swapped = true;
        return true;
      }
      if (kind === "write" && path.endsWith("companion.log.2")) {
        swapped = true;
        return true;
      }
      return false;
    };
    const logger = createOperationalLogger({ logDirectory: directory, maxBytes: 256, maxFiles: 3 });

    await logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    }).catch(() => undefined);
    const outsideSource = await textOrMissing(join(outside, "companion.log.1"));
    const outsideDestination = await textOrMissing(join(outside, "companion.log.2"));
    expect(swapped).toBe(true);
    expect(outsideSource).toBe("outside-source-victim\n");
    expect(outsideDestination).toBe("MISSING");
  });

  it("does not delete or modify an outside active log when maxFiles is one", async () => {
    const root = await actualFs.mkdtemp(join(tmpdir(), "hud-rotation-single-swap-"));
    cleanups.push(() => actualFs.rm(root, { recursive: true, force: true }));
    const directory = join(root, "logs");
    const outside = join(root, "outside");
    await actualFs.mkdir(directory);
    await actualFs.mkdir(outside);
    await actualFs.writeFile(join(directory, "companion.log"), "x".repeat(255));
    await actualFs.writeFile(join(outside, "companion.log"), "outside-active-victim\n");
    let swapped = false;
    race.beforeMutation = async (kind, path) => {
      if (kind === "rm" && path.endsWith("companion.log")) {
        await actualFs.rm(join(outside, "companion.log"), { force: true });
        swapped = true;
        return true;
      }
      if (kind === "truncate" && path.endsWith("companion.log")) {
        swapped = true;
        return true;
      }
      return false;
    };
    const logger = createOperationalLogger({ logDirectory: directory, maxBytes: 256, maxFiles: 1 });

    await logger.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    }).catch(() => undefined);
    const outsideVictim = await textOrMissing(join(outside, "companion.log"));
    expect(swapped).toBe(true);
    expect(outsideVictim).toBe("outside-active-victim\n");
  });

  it("an old owner release cannot remove a successor lock", async () => {
    const directory = await actualFs.mkdtemp(join(tmpdir(), "hud-lock-successor-"));
    cleanups.push(() => actualFs.rm(directory, { recursive: true, force: true }));
    const lockPath = join(directory, ".companion.log.lock");
    const displacedLockPath = join(directory, ".companion.log.lock.displaced");
    let writeCount = 0;
    let signalFirst!: () => void;
    let signalSecond!: () => void;
    let resumeFirst!: () => void;
    let resumeSecond!: () => void;
    const firstReached = new Promise<void>((resolve) => { signalFirst = resolve; });
    const secondReached = new Promise<void>((resolve) => { signalSecond = resolve; });
    const firstMayWrite = new Promise<void>((resolve) => { resumeFirst = resolve; });
    const secondMayWrite = new Promise<void>((resolve) => { resumeSecond = resolve; });
    race.beforeMutation = async (kind, path) => {
      if (kind !== "write" || !path.endsWith("companion.log")) return false;
      writeCount += 1;
      if (writeCount === 1) {
        signalFirst();
        await firstMayWrite;
      } else if (writeCount === 2) {
        signalSecond();
        await secondMayWrite;
      }
      return false;
    };
    const first = createOperationalLogger({ logDirectory: directory, maxBytes: 512, maxFiles: 3 });
    const second = createOperationalLogger({ logDirectory: directory, maxBytes: 512, maxFiles: 3 });

    const firstWriting = first.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "info",
      event: "startup_requested"
    });
    await firstReached;
    await actualFs.rename(lockPath, displacedLockPath);
    const secondWriting = second.write({
      at: "2026-09-02T00:00:00.000Z",
      level: "warn",
      event: "crash_recovery"
    });
    await secondReached;

    resumeFirst();
    await firstWriting;
    await expect(actualFs.readFile(lockPath, "utf8")).resolves.toContain("\"token\"");

    resumeSecond();
    await secondWriting;
    await expect(actualFs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await actualFs.rm(displacedLockPath, { force: true });
  });
});
