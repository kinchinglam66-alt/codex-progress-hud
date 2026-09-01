import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOperationalLogger,
  type OperationalLogEntry,
  type OperationalLogger
} from "../../src/diagnostics/logger.js";

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

describe("operational logger", () => {
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
      protocolVersion: 1,
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
      protocolVersion: 1,
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

    for (let index = 0; index < 6_000; index += 1) {
      await logger.write({
        at: "2026-09-02T00:00:00.000Z",
        level: "info",
        event: "startup_requested",
        lifecycleState: "starting",
        protocolVersion: 1,
        elapsedMs: index
      });
    }

    const files = (await readdir(directory)).sort();
    expect(files).toEqual(["companion.log", "companion.log.1", "companion.log.2"]);
    const sizes = await Promise.all(files.map(async (file) => (await stat(join(directory, file))).size));
    expect(sizes.every((size) => size > 0 && size <= maxBytes)).toBe(true);
  }, 10_000);
});
