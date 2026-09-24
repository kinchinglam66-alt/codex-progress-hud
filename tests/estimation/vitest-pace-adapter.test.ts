import {resolve as fixturePath} from 'node:path';
import {describe, expect, it} from "vitest";
import {pairCompletedToolCapture, parseVitestPace, type ToolCapture} from "../../src/estimation/vitest-pace-adapter.js";
import type {ConversationRecord} from "../../src/observer/conversation-record.js";

const command = "node node_modules/vitest/vitest.mjs run tests/a.test.ts tests/b.test.ts tests/c.test.ts --reporter=json --maxWorkers=1 --no-file-parallelism";

function report(): Record<string, unknown> {
  const passedAssertions = () => Array.from({length: 15}, () => ({status: "passed", failureMessages: []}));
  return {
    success: true,
    numTotalTestSuites: 5,
    numPassedTestSuites: 5,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 45,
    numPassedTests: 45,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [
      {name: "tests/b.test.ts", status: "passed", message: "", startTime: 120, endTime: 140, assertionResults: passedAssertions()},
      {name: "tests/c.test.ts", status: "passed", message: "", startTime: 150, endTime: 180, assertionResults: passedAssertions()},
      {name: "tests/a.test.ts", status: "passed", message: "", startTime: 100, endTime: 110, assertionResults: passedAssertions()}
    ]
  };
}

function validCapture(): ToolCapture {
  return {
    name: "exec",
    actionId: "action-vitest",
    cwd: fixturePath("repo"),
    command,
    complete: true,
    exitCode: 0,
    startedAtMs: 90,
    endedAtMs: 200,
    output: JSON.stringify(report())
  };
}

function mutateCapture(capture: ToolCapture, kind: string): void {
  const parsed = JSON.parse(capture.output) as Record<string, any>;
  const results = parsed.testResults as Array<Record<string, any>>;
  switch (kind) {
    case "incomplete":
      capture.complete = false;
      break;
    case "failed":
      capture.exitCode = 1;
      break;
    case "overlap":
      results[1]!.startTime = 105;
      capture.output = JSON.stringify(parsed);
      break;
    case "outside-host":
      results[2]!.endTime = 201;
      capture.output = JSON.stringify(parsed);
      break;
    case "duplicate":
      results[1]!.name = results[0]!.name;
      capture.output = JSON.stringify(parsed);
      break;
    case "skipped":
      (results[1]!.assertionResults as Array<Record<string, unknown>>)[0]!.status = "pending";
      capture.output = JSON.stringify(parsed);
      break;
    case "shell-wrapper":
      capture.command = `echo x && ${capture.command}`;
      break;
    case "missing-cwd":
      capture.cwd = "";
      break;
    default:
      throw new Error(`unknown mutation ${kind}`);
  }
}

describe("strict Vitest pace adapter", () => {
  it("accepts a complete direct JSON Vitest run and sorts fractional file intervals", () => {
    const capture = validCapture();
    capture.output = capture.output.replace("120", "120.25").replace("140", "140.5");

    expect(parseVitestPace(capture)).toEqual({
      files: [
        {identity: "tests/a.test.ts", startMs: 100, endMs: 110},
        {identity: "tests/b.test.ts", startMs: 120.25, endMs: 140.5},
        {identity: "tests/c.test.ts", startMs: 150, endMs: 180}
      ],
      signature: expect.stringContaining("repo"),
      project: (process.platform === "win32" ? fixturePath("repo").toLowerCase() : fixturePath("repo"))
    });
  });

  it.each(["incomplete", "failed", "overlap", "outside-host", "duplicate", "skipped", "shell-wrapper", "missing-cwd"])("%s abstains", kind => {
    const capture = validCapture();
    mutateCapture(capture, kind);
    expect(parseVitestPace(capture)).toBeNull();
  });

  it("rejects assistant-quoted JSON and clipped output before report admission", () => {
    const capture = validCapture();
    capture.output = `Here is the report: ${capture.output}`;
    expect(parseVitestPace(capture)).toBeNull();

    const clipped = validCapture();
    clipped.output = `${clipped.output}${"x".repeat(65_537)}`;
    expect(parseVitestPace(clipped)).toBeNull();
  });

  it("rejects retry-bearing evidence and inconsistent summary counts", () => {
    const retried = validCapture();
    const retriedReport = JSON.parse(retried.output) as Record<string, any>;
    (retriedReport.testResults as Array<Record<string, unknown>>)[0]!.retryCount = 1;
    retried.output = JSON.stringify(retriedReport);
    expect(parseVitestPace(retried)).toBeNull();

    const inconsistent = validCapture();
    const inconsistentReport = JSON.parse(inconsistent.output) as Record<string, unknown>;
    inconsistentReport.numPassedTests = 2;
    inconsistent.output = JSON.stringify(inconsistentReport);
    expect(parseVitestPace(inconsistent)).toBeNull();
  });

  it("requires every assertion to be passed with no failure messages", () => {
    const failed = validCapture();
    const failedReport = JSON.parse(failed.output) as Record<string, any>;
    const failedAssertion = (failedReport.testResults as Array<Record<string, any>>)[0]!.assertionResults[0];
    failedAssertion.status = "failed";
    failed.output = JSON.stringify(failedReport);
    expect(parseVitestPace(failed)).toBeNull();

    const message = validCapture();
    const messageReport = JSON.parse(message.output) as Record<string, any>;
    const messageAssertion = (messageReport.testResults as Array<Record<string, any>>)[0]!.assertionResults[0];
    messageAssertion.failureMessages = ["failure"];
    message.output = JSON.stringify(messageReport);
    expect(parseVitestPace(message)).toBeNull();
  });

  it.each([
    ["missing status", (file: Record<string, unknown>) => { delete file.status; }],
    ["missing message", (file: Record<string, unknown>) => { delete file.message; }],
    ["failed status", (file: Record<string, unknown>) => { file.status = "failed"; }],
    ["non-empty message", (file: Record<string, unknown>) => { file.message = "failure"; }]
  ])("rejects file-level %s evidence", (_name, mutate) => {
    const capture = validCapture();
    const parsed = JSON.parse(capture.output) as Record<string, any>;
    mutate((parsed.testResults as Array<Record<string, unknown>>)[0]!);
    capture.output = JSON.stringify(parsed);
    expect(parseVitestPace(capture)).toBeNull();
  });

  it("requires the exact selected file set and rejects wildcard paths", () => {
    const wildcard = validCapture();
    wildcard.command = wildcard.command.replace("tests/a.test.ts tests/b.test.ts tests/c.test.ts", "tests/*.test.ts");
    expect(parseVitestPace(wildcard)).toBeNull();

    const mismatch = validCapture();
    const mismatchReport = JSON.parse(mismatch.output) as Record<string, any>;
    (mismatchReport.testResults as Array<Record<string, unknown>>)[2]!.name = "tests/other.test.ts";
    mismatch.output = JSON.stringify(mismatchReport);
    expect(parseVitestPace(mismatch)).toBeNull();
  });

  it("rejects ambiguous or conflicting completed pairs", () => {
    const start: ConversationRecord = {
      id: "start", turnId: "turn", atMs: 100, kind: "tool_start", actionId: "action",
      toolName: "CommandExecution", cwd: fixturePath("repo"), command, startedAtMs: 100
    };
    const result: ConversationRecord = {
      id: "result", turnId: "turn", atMs: 200, kind: "tool_result", actionId: "action",
      toolName: "CommandExecution", cwd: fixturePath("repo"), command, complete: true, exitCode: 0,
      endedAtMs: 200, output: JSON.stringify(report()), outputComplete: true
    };
    expect(pairCompletedToolCapture([start, result, {...start, id: "duplicate-start"}])).toBeNull();
    expect(pairCompletedToolCapture([start, {...result, cwd: fixturePath("other")}])).toBeNull();
    expect(pairCompletedToolCapture([start, {...result, command: `${command} --unknown`}])).toBeNull();
    expect(pairCompletedToolCapture([start, {...result, toolName: "other-tool"}])).toBeNull();
  });
});
