import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { z } from "zod";
import { calibrationSummarySchema, type CalibrationSummary } from "../core/calibration.js";

const CALIBRATION_SCHEMA_VERSION = 2 as const;
const DEFAULT_MAX_SUMMARIES = 64;

const calibrationDocumentSchema = z
  .object({
    schemaVersion: z.literal(CALIBRATION_SCHEMA_VERSION),
    summaries: z.array(calibrationSummarySchema)
  })
  .strict();

export interface CalibrationFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink?(path: string): Promise<void>;
}

export interface CalibrationStoreOptions {
  maxSummaries?: number;
  fileSystem?: CalibrationFileSystem;
}

const nodeFileSystem: CalibrationFileSystem = {
  readFile: async (path) => await readFile(path, "utf8"),
  writeFile: async (path, content) => await writeFile(path, content, "utf8"),
  rename,
  unlink
};

function boundedSummaries(
  values: readonly CalibrationSummary[],
  maxSummaries: number
): CalibrationSummary[] {
  return [...values]
    .sort((left, right) => left.phaseClass.localeCompare(right.phaseClass))
    .slice(0, maxSummaries)
    .map((summary) => ({ ...summary }));
}

export class CalibrationStore {
  #filePath: string;
  #temporaryPath: string;
  #maxSummaries: number;
  #fileSystem: CalibrationFileSystem;

  constructor(filePath: string, options: CalibrationStoreOptions = {}) {
    this.#filePath = filePath;
    this.#temporaryPath = `${filePath}.tmp`;
    this.#maxSummaries = options.maxSummaries ?? DEFAULT_MAX_SUMMARIES;
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
    if (!Number.isSafeInteger(this.#maxSummaries) || this.#maxSummaries < 1) {
      throw new RangeError("maxSummaries must be a positive safe integer");
    }
  }

  async load(): Promise<CalibrationSummary[]> {
    try {
      const document = calibrationDocumentSchema.parse(
        JSON.parse(await this.#fileSystem.readFile(this.#filePath))
      );
      return boundedSummaries(document.summaries, this.#maxSummaries);
    } catch {
      return [];
    }
  }

  async save(values: readonly CalibrationSummary[]): Promise<void> {
    const parsed = values.map((value) => calibrationSummarySchema.parse(value));
    const document = {
      schemaVersion: CALIBRATION_SCHEMA_VERSION,
      summaries: boundedSummaries(parsed, this.#maxSummaries)
    };
    const content = `${JSON.stringify(document)}\n`;
    try {
      await this.#fileSystem.writeFile(this.#temporaryPath, content);
      await this.#fileSystem.rename(this.#temporaryPath, this.#filePath);
    } catch {
      if (this.#fileSystem.unlink !== undefined) {
        await this.#fileSystem.unlink(this.#temporaryPath).catch(() => undefined);
      }
    }
  }
}
