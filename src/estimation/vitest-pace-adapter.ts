import {resolve} from "node:path";
import {z} from "zod";
import type {ConversationRecord} from "../observer/conversation-record.js";

const MAX_REPORT_BYTES = 65_536;
const MAX_FILES = 256;
const MAX_ASSERTIONS_PER_FILE = 4_096;
const MAX_TOTAL_ASSERTIONS = 65_536;
const MAX_COUNT = 65_536;

export interface ToolCapture {
  name: string;
  actionId: string;
  cwd: string;
  command: string;
  complete: boolean;
  exitCode: number | null;
  startedAtMs: number;
  endedAtMs: number;
  output: string;
}

export interface CompletedToolCapture extends ToolCapture {
  turnId: string;
}

export interface ParsedPace {
  files: readonly {identity: string; startMs: number; endMs: number}[];
  signature: string;
  project: string;
}

const finiteMs = z.number().finite();
const count = z.number().int().nonnegative().max(MAX_COUNT);
const assertionSchema = z.object({
  status: z.literal("passed"),
  failureMessages: z.array(z.literal("")).length(0)
}).passthrough();
const fileSchema = z.object({
  name: z.string().min(1).max(4_096),
  status: z.literal("passed"),
  message: z.literal(""),
  startTime: finiteMs,
  endTime: finiteMs,
  assertionResults: z.array(assertionSchema).max(MAX_ASSERTIONS_PER_FILE)
}).passthrough();
const reportSchema = z.object({
  success: z.literal(true),
  numTotalTestSuites: count,
  numPassedTestSuites: count,
  numFailedTestSuites: z.literal(0),
  numPendingTestSuites: z.literal(0),
  numTotalTests: count,
  numPassedTests: count,
  numFailedTests: z.literal(0),
  numPendingTests: z.literal(0),
  testResults: z.array(fileSchema).min(1).max(MAX_FILES)
}).passthrough();

type VitestReport = z.infer<typeof reportSchema>;

function normalizedCwd(cwd: string): string {
  const normalized = resolve(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizedFileIdentity(cwd: string, identity: string): string {
  const normalized = resolve(cwd, identity.replaceAll("\\", "/"));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hasWildcard(identity: string): boolean {
  return /[*?\[\]{}]/u.test(identity);
}

function tokenizeDirectCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if ("&|;<>()$`".includes(character)) return null;
    if (quote === null && (character === "'" || character === '"')) {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (quote !== null && character === quote) {
      quote = null;
      continue;
    }
    if (quote === null && /\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += character;
    tokenStarted = true;
  }
  if (quote !== null) return null;
  if (tokenStarted) tokens.push(current);
  return tokens.length > 0 ? tokens : null;
}

function directVitestCommand(command: string): {executable: string; runner: string; fileNames: string[]; args: string[]} | null {
  const tokens = tokenizeDirectCommand(command);
  if (tokens === null || tokens.length < 7) return null;
  const [executable, runner, subcommand] = tokens;
  if (executable === undefined || runner === undefined || subcommand !== "run") return null;
  const executableName = executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  if (executableName !== "node" && executableName !== "node.exe") return null;
  if (runner.replaceAll("\\", "/") !== "node_modules/vitest/vitest.mjs") return null;

  const fileNames: string[] = [];
  const args: string[] = [subcommand];
  let flagsStarted = false;
  const requiredFlags = new Set(["--reporter=json", "--maxWorkers=1", "--no-file-parallelism"]);
  const seenFlags = new Set<string>();
  for (const token of tokens.slice(3)) {
    if (token.startsWith("--")) {
      flagsStarted = true;
      if (!requiredFlags.has(token) || seenFlags.has(token)) return null;
      seenFlags.add(token);
      args.push(token);
      continue;
    }
    if (flagsStarted || token.length === 0 || token.startsWith("-") || hasWildcard(token)) return null;
    fileNames.push(token);
  }
  if (fileNames.length === 0 || new Set(fileNames).size !== fileNames.length || seenFlags.size !== requiredFlags.size) return null;
  return {executable, runner, fileNames, args};
}

function hasRetryEvidence(report: VitestReport): boolean {
  const retryKeys = new Set(["attempts", "retry", "retryCount", "retryReasons", "invocations"]);
  for (const file of report.testResults) {
    for (const key of retryKeys) {
      if (key in file) return true;
    }
    for (const assertion of file.assertionResults) {
      for (const key of retryKeys) {
        if (key in assertion) return true;
      }
    }
  }
  return false;
}

function validatedReport(output: string): VitestReport | null {
  if (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(output) as unknown;
  } catch {
    return null;
  }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success || hasRetryEvidence(parsed.data)) return null;
  const report = parsed.data;
  if (report.numPassedTestSuites !== report.numTotalTestSuites ||
      report.numTotalTestSuites < report.testResults.length ||
      report.numTotalTests !== report.numPassedTests) return null;
  let assertionCount = 0;
  for (const file of report.testResults) assertionCount += file.assertionResults.length;
  if (assertionCount > MAX_TOTAL_ASSERTIONS || report.numTotalTests !== assertionCount) return null;
  return report;
}

export function pairCompletedToolCapture(records: readonly ConversationRecord[]): CompletedToolCapture | null {
  const starts = records.filter(record => record.kind === "tool_start" && record.actionId && record.turnId !== null);
  const results = records.filter(record => record.kind === "tool_result" && record.actionId && record.turnId !== null);
  for (const start of starts) {
    const samePairStarts = starts.filter(candidate => candidate.actionId === start.actionId && candidate.turnId === start.turnId);
    const matches = results.filter(result => result.actionId === start.actionId && result.turnId === start.turnId);
    if (samePairStarts.length !== 1 || matches.length !== 1) continue;
    const result = matches[0]!;
    const command = start.command ?? result.command;
    const cwd = start.cwd ?? result.cwd;
    const toolName = start.toolName ?? result.toolName;
    if ((start.command !== undefined && result.command !== undefined && start.command !== result.command) ||
        (start.cwd !== undefined && result.cwd !== undefined && start.cwd !== result.cwd) ||
        (start.toolName !== undefined && result.toolName !== undefined && start.toolName !== result.toolName)) continue;
    if (result.complete !== true || result.exitCode === undefined || result.endedAtMs === undefined ||
        result.output === undefined || result.outputComplete === false || start.startedAtMs === undefined ||
        command === undefined || cwd === undefined || toolName === undefined) continue;
    return {
      name: toolName,
      actionId: start.actionId!,
      cwd,
      command,
      complete: true,
      exitCode: result.exitCode,
      startedAtMs: start.startedAtMs,
      endedAtMs: result.endedAtMs,
      output: result.output,
      turnId: start.turnId!
    };
  }
  return null;
}

export function parseVitestPace(capture: ToolCapture): ParsedPace | null {
  if (!capture.complete || capture.exitCode !== 0 || !capture.cwd || !capture.actionId || !capture.name ||
      !Number.isFinite(capture.startedAtMs) || !Number.isFinite(capture.endedAtMs) ||
      capture.endedAtMs <= capture.startedAtMs) return null;
  const command = directVitestCommand(capture.command);
  if (command === null) return null;
  const report = validatedReport(capture.output);
  if (report === null) return null;

  const intervals = report.testResults.map(file => ({
    identity: file.name,
    startMs: file.startTime,
    endMs: file.endTime
  })).sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.identity.localeCompare(right.identity));
  const names = new Set<string>();
  const selectedFiles = command.fileNames.map(fileName => normalizedFileIdentity(capture.cwd, fileName));
  const selectedSet = new Set(selectedFiles);
  if (selectedSet.size !== selectedFiles.length || selectedSet.size !== intervals.length) return null;
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const interval of intervals) {
    if (names.has(interval.identity) || interval.endMs <= interval.startMs ||
        interval.startMs < capture.startedAtMs || interval.endMs > capture.endedAtMs ||
        interval.startMs < previousEnd) return null;
    names.add(interval.identity);
    previousEnd = interval.endMs;
  }
  const observedSet = new Set(intervals.map(interval => normalizedFileIdentity(capture.cwd, interval.identity)));
  if (observedSet.size !== selectedSet.size || [...observedSet].some(identity => !selectedSet.has(identity))) return null;
  return {
    files: intervals,
    signature: JSON.stringify({
      cwd: normalizedCwd(capture.cwd),
      executable: command.executable,
      runner: command.runner,
      args: command.args
    }),
    project: normalizedCwd(capture.cwd)
  };
}
