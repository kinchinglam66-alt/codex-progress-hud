import { describe, expect, it } from "vitest";
import {
  CalibrationStore,
  type CalibrationFileSystem
} from "../../src/server/calibration-store.js";
import type { CalibrationSummary } from "../../src/core/calibration.js";

class MemoryFileSystem implements CalibrationFileSystem {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  readonly renames: Array<[string, string]> = [];

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      const error = new Error("missing");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    }
    return value;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.writes.push(path);
    this.files.set(path, content);
  }

  async rename(from: string, to: string): Promise<void> {
    this.renames.push([from, to]);
    const content = this.files.get(from);
    if (content === undefined) throw new Error("temporary file missing");
    this.files.set(to, content);
    this.files.delete(from);
  }
}

const summaries: CalibrationSummary[] = [
  {
    phaseClass: "testing",
    sampleCount: 4,
    averageDurationSeconds: 120,
    averageEstimateErrorSeconds: 20
  },
  {
    phaseClass: "implementation",
    sampleCount: 3,
    averageDurationSeconds: 300,
    averageEstimateErrorSeconds: 40
  },
  {
    phaseClass: "review",
    sampleCount: 5,
    averageDurationSeconds: 90,
    averageEstimateErrorSeconds: 10
  }
];

describe("private calibration persistence", () => {
  it("writes only a strict versioned, content-free bounded summary document atomically", async () => {
    const fileSystem = new MemoryFileSystem();
    const store = new CalibrationStore("calibration.json", {
      maxSummaries: 2,
      fileSystem
    });

    await store.save(summaries);

    expect(fileSystem.writes).toEqual(["calibration.json.tmp"]);
    expect(fileSystem.renames).toEqual([["calibration.json.tmp", "calibration.json"]]);
    const persisted = JSON.parse(fileSystem.files.get("calibration.json")!);
    expect(persisted).toEqual({
      schemaVersion: 1,
      summaries: [summaries[1], summaries[2]]
    });
    expect(JSON.stringify(persisted)).not.toMatch(/title|task|prompt|path|repository|output/i);
  });

  it("rejects extra fields instead of persisting task content", async () => {
    const fileSystem = new MemoryFileSystem();
    const store = new CalibrationStore("calibration.json", { fileSystem });

    await expect(
      store.save([
        {
          ...summaries[0],
          title: "must not be stored"
        } as CalibrationSummary & { title: string }
      ])
    ).rejects.toThrow();
    expect(fileSystem.writes).toEqual([]);
  });

  it("returns an empty calibration set for missing, corrupt, or unsupported files", async () => {
    const fileSystem = new MemoryFileSystem();
    const store = new CalibrationStore("calibration.json", { fileSystem });

    await expect(store.load()).resolves.toEqual([]);
    fileSystem.files.set("calibration.json", "not-json");
    await expect(store.load()).resolves.toEqual([]);
    fileSystem.files.set(
      "calibration.json",
      JSON.stringify({ schemaVersion: 2, summaries })
    );
    await expect(store.load()).resolves.toEqual([]);
  });

  it("loads valid records without exposing any live task state", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set(
      "calibration.json",
      JSON.stringify({ schemaVersion: 1, summaries: [summaries[0]] })
    );
    const store = new CalibrationStore("calibration.json", { fileSystem });

    await expect(store.load()).resolves.toEqual([summaries[0]]);
  });
});
