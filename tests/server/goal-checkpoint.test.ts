import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ETA_TIME_BASIS } from "../../src/core/eta-time-contract.js";
import {
  createGoalCheckpointRepository,
  type GoalCheckpointRecord
} from "../../src/server/goal-checkpoint.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "goal-checkpoint-test-"));
  directories.push(directory);
  return directory;
}

function record(index = 1, savedAtMs = 1_700_000_000_000): GoalCheckpointRecord {
  return {
    sessionKey: `session-${index}`,
    turnKey: `turn-${index}`,
    generation: index,
    estimateRevision: index + 1,
    savedAtMs,
    activeSeconds: 1200,
    runtime: "running",
    status: "running",
    prediction: {
      remainingSeconds: 800,
      errorPercent: 30,
      observedActiveSeconds: 1000
    },
    progressFloor: 42,
    timingUncertain: true
  };
}

function repository(directory: string, sourceIdentity = "source-a", now = 1_700_000_000_000) {
  return createGoalCheckpointRepository({
    directory,
    sourceIdentity,
    isOwner: async () => true,
    now: () => now
  });
}

async function checkpointPath(directory: string): Promise<string> {
  return join(directory, "goal-checkpoint.json");
}

describe("goal checkpoint repository", () => {
  it("round-trips strict value-only records and keeps prediction anchors", async () => {
    const directory = await makeDirectory();
    const source = repository(directory);

    await source.save([record()]);

    await expect(source.load()).resolves.toEqual([record()]);
    const persisted = await readFile(await checkpointPath(directory), "utf8");
    expect(JSON.parse(persisted)).toEqual({
      schemaVersion: 1,
      sourceIdentity: "source-a",
      records: [record()]
    });
    expect(persisted).not.toContain(directory);
    expect(persisted).not.toMatch(/summary|prompt|credential|password/i);
  });

  it("reads and re-saves legacy records without assigning a time basis", async () => {
    const directory = await makeDirectory();
    const path = await checkpointPath(directory);
    const legacyRecord = record();
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      sourceIdentity: "source-a",
      records: [legacyRecord]
    }));
    const source = repository(directory);

    await expect(source.load()).resolves.toEqual([legacyRecord]);
    await source.save(await source.load());

    const persisted = JSON.parse(await readFile(path, "utf8")) as { records: Array<Record<string, unknown>> };
    expect(persisted.records).toEqual([legacyRecord]);
    expect(persisted.records[0]).not.toHaveProperty("timeBasis");
    await expect(source.load()).resolves.toEqual([legacyRecord]);
  });

  it("round-trips records with the explicit time basis", async () => {
    const directory = await makeDirectory();
    const source = repository(directory);
    const versionedRecord: GoalCheckpointRecord = { ...record(), timeBasis: ETA_TIME_BASIS };

    await source.save([versionedRecord]);

    await expect(source.load()).resolves.toEqual([versionedRecord]);
    const persisted = JSON.parse(await readFile(await checkpointPath(directory), "utf8")) as {
      schemaVersion: number;
      records: GoalCheckpointRecord[];
    };
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.records).toEqual([versionedRecord]);
  });

  it("rejects a record with an unsupported time basis", async () => {
    const directory = await makeDirectory();
    const source = repository(directory);

    await expect(source.save([
      { ...record(), timeBasis: "active-seconds-v0" } as unknown as GoalCheckpointRecord
    ])).rejects.toThrow(/time basis/i);
  });

  it("returns no records for a different opaque source identity", async () => {
    const directory = await makeDirectory();
    await repository(directory, "source-a").save([record()]);

    await expect(repository(directory, "source-b").load()).resolves.toEqual([]);
  });

  it("rejects unknown fields and numeric values outside the checkpoint contract", async () => {
    const directory = await makeDirectory();
    const source = repository(directory);

    await expect(source.save([{ ...record(), extra: "not allowed" } as GoalCheckpointRecord])).rejects.toThrow();
    await expect(source.save([{ ...record(), activeSeconds: Number.NaN }])).rejects.toThrow();
    await expect(source.save([{ ...record(), progressFloor: 100 }])).rejects.toThrow();
    await expect(source.save([{
      ...record(),
      prediction: { ...record().prediction!, observedActiveSeconds: 1201 }
    }])).rejects.toThrow();
    await expect(source.save([{ ...record(), status: "completed" } as unknown as GoalCheckpointRecord])).rejects.toThrow();
    await expect(source.save([{ ...record(), sessionKey: record().sessionKey, turnKey: record().turnKey }])).resolves.toBeUndefined();
  });

  it("rejects duplicate session-turn pairs and terminal-looking records", async () => {
    const directory = await makeDirectory();
    const source = repository(directory);
    const first = record(1);

    await expect(source.save([first, { ...first, generation: 2 }])).rejects.toThrow();
    await expect(source.save([{ ...first, status: "unknown" }])).resolves.toBeUndefined();
    await expect(source.save([{ ...first, runtime: "completed" } as unknown as GoalCheckpointRecord])).rejects.toThrow();
  });

  it("filters records older than seven days and rejects future timestamps", async () => {
    const directory = await makeDirectory();
    const path = await checkpointPath(directory);
    const source = repository(directory);
    await source.save([
      record(1, 1_700_000_000_000 - 7 * DAY_MS),
      record(2, 1_700_000_000_000 - 7 * DAY_MS - 1),
      record(3, 1_700_000_000_000)
    ]);

    await expect(source.load()).resolves.toEqual([record(3), record(1, 1_700_000_000_000 - 7 * DAY_MS)]);
    const future = JSON.parse(await readFile(path, "utf8")) as { records: GoalCheckpointRecord[] };
    future.records[0] = { ...future.records[0]!, savedAtMs: 1_700_000_000_001 };
    await writeFile(path, JSON.stringify({ schemaVersion: 1, sourceIdentity: "source-a", records: future.records }));
    await expect(source.load()).rejects.toThrow(/future|timestamp|checkpoint/i);
  });

  it("retains only the newest 256 records in newest-first order", async () => {
    const directory = await makeDirectory();
    const source = repository(directory, "source-a", 1_700_000_000_300);
    const records = Array.from({ length: 260 }, (_, index) => record(index, 1_700_000_000_000 + index));

    await source.save(records);

    await expect(source.load()).resolves.toEqual(records.slice(-256).reverse());
  });

  it("rejects oversized and unsupported checkpoint documents before parsing them", async () => {
    const directory = await makeDirectory();
    const path = await checkpointPath(directory);
    const source = repository(directory);

    await writeFile(path, "x".repeat(1024 * 1024 + 1));
    await expect(source.load()).rejects.toThrow(/checkpoint|size|large|invalid/i);
    await writeFile(path, JSON.stringify({ schemaVersion: 2, sourceIdentity: "source-a", records: [] }));
    await expect(source.load()).rejects.toThrow(/schema|checkpoint|invalid/i);
  });

  it("refuses linked checkpoint targets", async () => {
    const directory = await makeDirectory();
    const realPath = join(directory, "real.json");
    const path = await checkpointPath(directory);
    await writeFile(realPath, "{}", "utf8");
    try {
      await symlink(realPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }

    await expect(repository(directory).load()).rejects.toThrow(/regular|link|trusted|checkpoint/i);
    await expect(repository(directory).save([record()])).rejects.toThrow(/regular|link|trusted|checkpoint/i);
  });

  it("refuses a checkpoint directory reached through a linked ancestor", async () => {
    const root = await makeDirectory();
    const outside = await makeDirectory();
    const linkedAncestor = join(root, "linked-ancestor");
    await mkdir(join(outside, "leaf"));
    try {
      await symlink(outside, linkedAncestor, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }

    await expect(repository(join(linkedAncestor, "leaf")).load()).rejects.toThrow(/link|trusted|directory/i);
  });

  it("refuses checkpoint targets with more than one hard link", async () => {
    const directory = await makeDirectory();
    const path = await checkpointPath(directory);
    await repository(directory).save([record()]);
    try {
      await link(path, join(directory, "checkpoint-alias.json"));
    } catch (error) {
      if (["EACCES", "EPERM", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }

    await expect(repository(directory).load()).rejects.toThrow(/link|regular|checkpoint/i);
    await expect(repository(directory).save([record(2)])).rejects.toThrow(/link|regular|checkpoint/i);
  });

  it("rejects two turns for the same session instead of restoring ambiguously", async () => {
    const directory = await makeDirectory();
    const first = record(1);
    const secondTurn = { ...record(2), sessionKey: first.sessionKey, turnKey: "turn-different" };

    await expect(repository(directory).save([first, secondTurn])).rejects.toThrow(/duplicate|session|turn/i);
  });

  it("rejects a temporary file that becomes hard-linked before replacement", async () => {
    const directory = await makeDirectory();
    let ownerChecks = 0;
    const source = createGoalCheckpointRepository({
      directory,
      sourceIdentity: "source-a",
      isOwner: async () => {
        ownerChecks += 1;
        if (ownerChecks === 2) {
          const temporaryName = (await readdir(directory)).find(name => name.startsWith(".goal-checkpoint.json.") && name.endsWith(".tmp"));
          expect(temporaryName).toBeDefined();
          try {
            await link(join(directory, temporaryName!), join(directory, "temporary-alias.tmp"));
          } catch (error) {
            if (["EACCES", "EPERM", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return true;
            throw error;
          }
        }
        return true;
      },
      now: () => 1_700_000_000_000
    });

    await expect(source.save([record()])).rejects.toThrow(/link|regular|temporary|changed/i);
  });

  it("refuses a save after ownership is lost and preserves the prior file", async () => {
    const directory = await makeDirectory();
    let owner = true;
    const source = createGoalCheckpointRepository({
      directory,
      sourceIdentity: "source-a",
      isOwner: async () => owner,
      now: () => 1_700_000_000_000
    });
    await source.save([record(1)]);
    owner = false;

    await expect(source.save([record(2)])).rejects.toThrow(/owner|ownership/i);
    await expect(source.load()).resolves.toEqual([record(1)]);
  });

  it("snapshots input and serializes writes in invocation order", async () => {
    const directory = await makeDirectory();
    let releaseOwner: (() => void) | undefined;
    const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve; });
    let firstOwnerCheck = true;
    const source = createGoalCheckpointRepository({
      directory,
      sourceIdentity: "source-a",
      isOwner: async () => {
        if (firstOwnerCheck) {
          firstOwnerCheck = false;
          await ownerGate;
        }
        return true;
      },
      now: () => 1_700_000_000_000
    });
    const first = [record(1)];
    const second = [record(2)];
    const firstSave = source.save(first);
    first[0] = record(3);
    const secondSave = source.save(second);
    releaseOwner!();

    await Promise.all([firstSave, secondSave]);
    await expect(source.load()).resolves.toEqual([record(2)]);
  });

  it("fences separate repository instances while ownership is delayed and lost", async () => {
    const directory = await makeDirectory();
    let releaseFirstOwner: (() => void) | undefined;
    let firstOwnerEntered: (() => void) | undefined;
    let secondOwnerEntered: (() => void) | undefined;
    const firstOwnerGate = new Promise<void>(resolve => { releaseFirstOwner = resolve; });
    const firstOwnerStarted = new Promise<void>(resolve => { firstOwnerEntered = resolve; });
    const secondOwnerStarted = new Promise<void>(resolve => { secondOwnerEntered = resolve; });
    const first = createGoalCheckpointRepository({
      directory,
      sourceIdentity: "source-a",
      isOwner: async () => {
        firstOwnerEntered!();
        await firstOwnerGate;
        return false;
      },
      now: () => 1_700_000_000_000
    });
    const second = createGoalCheckpointRepository({
      directory,
      sourceIdentity: "source-a",
      isOwner: async () => {
        secondOwnerEntered!();
        return true;
      },
      now: () => 1_700_000_000_000
    });

    const firstSave = first.save([record(1)]);
    await firstOwnerStarted;
    const secondSave = second.save([record(2)]);
    const raceResult = await Promise.race([
      secondOwnerStarted.then(() => "entered"),
      new Promise(resolve => setTimeout(() => resolve("blocked"), 50))
    ]);
    expect(raceResult).toBe("blocked");

    releaseFirstOwner!();
    await expect(firstSave).rejects.toThrow(/owner|ownership/i);
    await expect(secondSave).resolves.toBeUndefined();
    await expect(second.load()).resolves.toEqual([record(2)]);
  });
});
