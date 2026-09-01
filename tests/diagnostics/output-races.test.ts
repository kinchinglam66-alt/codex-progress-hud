import * as actualFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string) => Promise<boolean>),
  realOpen: undefined as undefined | typeof import("node:fs/promises").open
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  race.realOpen = original.open;
  return {
    ...original,
    open: async (...arguments_: Parameters<typeof original.open>) => {
      const path = String(arguments_[0]);
      const beforeOpen = race.beforeOpen;
      if (beforeOpen !== undefined) {
        if (await beforeOpen(path)) race.beforeOpen = undefined;
      }
      return original.open(...arguments_);
    }
  };
});

import { createOperationalLogger } from "../../src/diagnostics/logger.js";
import { writeDiagnosticReport, type DiagnosticReportInput } from "../../src/diagnostics/report.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  race.beforeOpen = undefined;
  while (cleanups.length > 0) await cleanups.pop()?.();
});

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
  it("rejects a directory substitution before report content is written", async () => {
    const root = await actualFs.mkdtemp(join(tmpdir(), "hud-output-swap-"));
    cleanups.push(() => actualFs.rm(root, { recursive: true, force: true }));
    const directory = join(root, "reports");
    const parked = join(root, "reports-parked");
    const outside = join(root, "outside");
    await actualFs.mkdir(directory);
    await actualFs.mkdir(outside);
    race.beforeOpen = async (path) => {
      if (!path.endsWith(".md")) return false;
      await actualFs.rename(directory, parked);
      await actualFs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
      return true;
    };

    await expect(writeDiagnosticReport(reportInput(directory))).rejects.toThrow(
      /changed|trusted directory/iu
    );

    const outsideFiles = await actualFs.readdir(outside);
    for (const file of outsideFiles) {
      await expect(actualFs.readFile(join(outside, file), "utf8")).resolves.toBe("");
    }
    await actualFs.rm(directory, { force: true });
    await actualFs.rename(parked, directory);
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
    await expect(actualFs.readFile(linked, "utf8")).resolves.toBe("");
  });
});
