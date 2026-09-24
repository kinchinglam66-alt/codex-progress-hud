import {resolve as fixturePath} from 'node:path';
import {describe, expect, it} from "vitest";
import {PaceMeasurements, parsePaceEvidence, type PaceContinuity, type PaceEvidence} from "../../src/estimation/pace-measurements.js";
import type {ConversationRecord} from "../../src/observer/conversation-record.js";

const command = (files: readonly string[]) =>
  `node node_modules/vitest/vitest.mjs run ${files.join(" ")} --reporter=json --maxWorkers=1 --no-file-parallelism`;

function report(files: readonly string[]): string {
  return JSON.stringify({
    success: true,
    numTotalTestSuites: files.length,
    numPassedTestSuites: files.length,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: files.length,
    numPassedTests: files.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: files.map((name, index) => ({
      name,
      status: "passed",
      message: "",
      startTime: 1_000 + index * 100,
      endTime: 1_050 + index * 100,
      assertionResults: [{status: "passed", failureMessages: []}]
    }))
  });
}

function recordsFor(files: readonly string[], turnId = "turn-1", actionId = "action-1"): ConversationRecord[] {
  return [
    {
      id: `${actionId}-start`, turnId, atMs: 900, kind: "tool_start", actionId,
      toolName: "exec", cwd: fixturePath("repo"), command: command(files), startedAtMs: 900
    },
    {
      id: `${actionId}-result`, turnId, atMs: 1_500, kind: "tool_result", actionId,
      toolName: "exec", cwd: fixturePath("repo"), command: command(files), complete: true,
      exitCode: 0, endedAtMs: 1_500, output: report(files), outputComplete: true
    }
  ];
}

function evidence(files: readonly string[], turnId = "turn-1", actionId = "action-1"): PaceEvidence {
  return {
    files: files.map((identity, index) => ({
      identity,
      startMs: 1_000 + index * 100,
      endMs: 1_050 + index * 100
    })),
    signature: "signature-v1",
    project: (process.platform === "win32" ? fixturePath("repo").toLowerCase() : fixturePath("repo")),
    turnId,
    actionId,
    startedAtMs: 900,
    endedAtMs: Math.max(1_500, 1_050 + Math.max(0, files.length - 1) * 100)
  };
}

function continuity(overrides: Partial<PaceContinuity> = {}): PaceContinuity {
  return {
    sourceEpoch: 1,
    historyComplete: true,
    runningWindows: [{startMs: 900, endMs: 100_000}],
    competingActionWindows: [],
    ...overrides
  };
}

function eligibleOwner(): {owner: PaceMeasurements; goal: object} {
  const owner = new PaceMeasurements();
  const goal = {};
  owner.ingest(goal, evidence(["tests/a.ts", "tests/b.ts", "tests/c.ts"]), continuity());
  return {owner, goal};
}

describe("bounded pace measurement ownership", () => {
  it("bridges completed normalized records into invocation-scoped pace evidence", () => {
    const parsed = parsePaceEvidence(recordsFor(["tests/a.ts", "tests/b.ts", "tests/c.ts"]));

    expect(parsed).toMatchObject({
      turnId: "turn-1",
      actionId: "action-1",
      startedAtMs: 900,
      endedAtMs: 1_500,
      project: (process.platform === "win32" ? fixturePath("repo").toLowerCase() : fixturePath("repo"))
    });
    expect(parsed?.files).toHaveLength(3);
  });

  it("admits a three-file invocation with local seconds and fixed file units", () => {
    const {owner, goal} = eligibleOwner();

    expect(owner.snapshot(goal)).toEqual([{
      signature: "signature-v1",
      project: (process.platform === "win32" ? fixturePath("repo").toLowerCase() : fixturePath("repo")),
      workClass: "file_processing",
      unit: "file",
      intervals: [
        {workClass: "file_processing", unit: "file", startActiveSeconds: 0.1, endActiveSeconds: 0.15, completedUnits: 1, complete: true, serial: true},
        {workClass: "file_processing", unit: "file", startActiveSeconds: 0.2, endActiveSeconds: 0.25, completedUnits: 1, complete: true, serial: true},
        {workClass: "file_processing", unit: "file", startActiveSeconds: 0.3, endActiveSeconds: 0.35, completedUnits: 1, complete: true, serial: true}
      ]
    }]);
  });

  it("keeps only the latest five intervals in a compatible group", () => {
    const owner = new PaceMeasurements();
    const goal = {};
    owner.ingest(goal, evidence(["a", "b", "c", "d", "e", "f", "g"]), continuity());

    expect(owner.snapshot(goal)[0]?.intervals).toHaveLength(5);
    expect(owner.snapshot(goal)[0]?.intervals.map(interval => interval.startActiveSeconds)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
  });

  it("does not pool different host invocations and admits at most eight groups", () => {
    const owner = new PaceMeasurements();
    const goal = {};
    for (let index = 0; index < 9; index += 1) {
      owner.ingest(goal, evidence([`run-${index}-a`, `run-${index}-b`, `run-${index}-c`], `turn-${index}`, `action-${index}`), continuity());
    }

    expect(owner.snapshot(goal)).toHaveLength(8);
    expect(owner.snapshot(goal).every(group => group.intervals.length === 3)).toBe(true);
  });

  it("preserves a 1,024-identity bound without evicting seen identities", () => {
    const owner = new PaceMeasurements();
    const goal = {};
    for (let invocation = 0; invocation < 4; invocation += 1) {
      const files = Array.from({length: 256}, (_, index) => `tests/${invocation}-${index}.ts`);
      owner.ingest(goal, evidence(files, `turn-${invocation}`, `action-${invocation}`), continuity());
    }
    owner.ingest(goal, evidence(["tests/1024-new.ts"], "turn-new", "action-new"), continuity());

    expect(owner.snapshot(goal)).toHaveLength(4);
    expect(owner.snapshot(goal).reduce((count, group) => count + group.intervals.length, 0)).toBe(20);
  });

  it("is idempotent for repeated polls and does not count repeated files in another invocation", () => {
    const owner = new PaceMeasurements();
    const goal = {};
    const first = evidence(["a", "b", "c"]);
    owner.ingest(goal, first, continuity());
    owner.ingest(goal, first, continuity());
    owner.ingest(goal, evidence(["a", "b", "c"], "turn-2", "action-2"), continuity());

    expect(owner.snapshot(goal)).toHaveLength(1);
    expect(owner.snapshot(goal)[0]?.intervals).toHaveLength(3);
  });

  it("deduplicates normalized file paths across invocations", () => {
    const owner = new PaceMeasurements();
    const goal = {};
    owner.ingest(goal, evidence(["tests/a.ts", "tests/b.ts", "tests/c.ts"]), continuity());
    owner.ingest(goal, evidence([".\\tests\\a.ts", ".\\tests\\b.ts", ".\\tests\\c.ts"], "turn-2", "action-2"), continuity());

    expect(owner.snapshot(goal)).toHaveLength(1);
    expect(owner.snapshot(goal)[0]?.intervals).toHaveLength(3);
  });

  it("clears all scope evidence when history is incomplete or the source is lost", () => {
    const owner = new PaceMeasurements();
    const goal = {};
    owner.ingest(goal, evidence(["a", "b", "c"]), continuity());
    owner.ingest(goal, evidence(["d", "e", "f"], "turn-2", "action-2"), continuity());
    owner.ingest(goal, evidence(["g", "h", "i"], "turn-3", "action-3"), continuity({historyComplete: false}));
    expect(owner.snapshot(goal)).toEqual([]);

    owner.ingest(goal, evidence(["a", "b", "c"]), continuity());
    owner.ingest(goal, evidence(["a", "b", "c"]), continuity({sourceEpoch: null}));
    expect(owner.snapshot(goal)).toEqual([]);
  });

  it("abstains from a distinct mixed repeated-and-new report without marking its new file", () => {
    const owner = new PaceMeasurements();
    const goal = {};
    owner.ingest(goal, evidence(["a", "b", "c"]), continuity());
    owner.ingest(goal, evidence(["a", "b", "d"], "turn-2", "action-2"), continuity());

    expect(owner.snapshot(goal)).toHaveLength(1);
    owner.ingest(goal, evidence(["d", "e", "f"], "turn-3", "action-3"), continuity());
    expect(owner.snapshot(goal)).toHaveLength(2);
  });

  it("does not append a changed completed report under the same action identity", () => {
    const owner = new PaceMeasurements();
    const goal = {};
    owner.ingest(goal, evidence(["a", "b", "c"]), continuity());
    owner.ingest(goal, evidence(["a", "b", "c", "d"]), continuity());

    expect(owner.snapshot(goal)).toHaveLength(1);
    expect(owner.snapshot(goal)[0]?.intervals).toHaveLength(3);
  });

  it("invalidates affected evidence when history is incomplete or the host crosses a pause", () => {
    const {owner, goal} = eligibleOwner();

    owner.ingest(goal, evidence(["tests/a.ts", "tests/b.ts", "tests/c.ts"]), continuity({historyComplete: false}));
    expect(owner.snapshot(goal)).toEqual([]);

    owner.ingest(goal, evidence(["tests/a.ts", "tests/b.ts", "tests/c.ts"]), continuity());
    owner.ingest(goal, evidence(["tests/a.ts", "tests/b.ts", "tests/c.ts"]), continuity({
      runningWindows: [{startMs: 900, endMs: 1_100}, {startMs: 1_200, endMs: 1_500}]
    }));
    expect(owner.snapshot(goal)).toEqual([]);
  });

  it("rejects overlapping competing host actions", () => {
    const owner = new PaceMeasurements();
    const goal = {};
    owner.ingest(goal, evidence(["a", "b", "c"]), continuity({
      competingActionWindows: [{startMs: 1_100, endMs: 1_200}]
    }));

    expect(owner.snapshot(goal)).toEqual([]);
  });

  it("clears on source epoch changes and source loss", () => {
    const {owner, goal} = eligibleOwner();

    owner.ingest(goal, evidence(["new-a", "new-b", "new-c"], "turn-2", "action-2"), continuity({sourceEpoch: 2}));
    expect(owner.snapshot(goal)[0]?.intervals.map(interval => interval.startActiveSeconds)).toEqual([0.1, 0.2, 0.3]);

    owner.ingest(goal, evidence(["new-a", "new-b", "new-c"], "turn-2", "action-2"), continuity({sourceEpoch: null}));
    expect(owner.snapshot(goal)).toEqual([]);
  });

  it("isolates goal scopes, supports explicit clear, and returns fresh snapshots", () => {
    const owner = new PaceMeasurements();
    const goalA = {};
    const goalB = {};
    owner.ingest(goalA, evidence(["a", "b", "c"]), continuity());

    expect(owner.snapshot(goalB)).toEqual([]);
    const snapshot = owner.snapshot(goalA);
    (snapshot[0]!.intervals as unknown as Array<{completedUnits: number}>)[0]!.completedUnits = 99;
    expect(owner.snapshot(goalA)[0]!.intervals[0]!.completedUnits).toBe(1);

    owner.clear(goalA);
    expect(owner.snapshot(goalA)).toEqual([]);
    expect(owner.snapshot(goalB)).toEqual([]);
  });
});
