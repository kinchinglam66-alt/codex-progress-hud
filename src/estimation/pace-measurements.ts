import {resolve} from "node:path";
import {pairCompletedToolCapture, parseVitestPace, type ParsedPace} from "./vitest-pace-adapter.js";
import type {PaceInterval} from "./pace-correction.js";
import type {ConversationRecord} from "../observer/conversation-record.js";

const MAX_GROUPS = 8;
const MAX_IDENTITIES = 1_024;
const MAX_FILES = 256;
const MAX_SNAPSHOT_INTERVALS = 5;

export interface PaceWindow {
  startMs: number;
  endMs: number;
}

export interface PaceContinuity {
  sourceEpoch: number | null;
  historyComplete: boolean;
  runningWindows: readonly PaceWindow[];
  competingActionWindows: readonly PaceWindow[];
}

export interface PaceEvidence extends ParsedPace {
  turnId: string;
  actionId: string;
  startedAtMs: number;
  endedAtMs: number;
}

export interface PaceGroup {
  signature: string;
  project: string;
  workClass: "file_processing";
  unit: "file";
  intervals: readonly PaceInterval[];
}

interface StoredGroup {
  signature: string;
  project: string;
  intervals: PaceInterval[];
}

interface ScopeState {
  sourceEpoch: number;
  groups: Map<string, StoredGroup>;
  seenIdentities: Set<string>;
  identityAdmissionDisabled: boolean;
}

export function parsePaceEvidence(records: readonly ConversationRecord[]): PaceEvidence | null {
  const capture = pairCompletedToolCapture(records);
  if (capture === null) return null;
  const parsed = parseVitestPace(capture);
  if (parsed === null) return null;
  return {
    ...parsed,
    turnId: capture.turnId,
    actionId: capture.actionId,
    startedAtMs: capture.startedAtMs,
    endedAtMs: capture.endedAtMs
  };
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function validWindow(window: PaceWindow): boolean {
  return !!window && finite(window.startMs) && finite(window.endMs) && window.endMs > window.startMs;
}

function overlaps(left: PaceWindow, right: PaceWindow): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

function coversHostWindow(runningWindows: readonly PaceWindow[], startedAtMs: number, endedAtMs: number): boolean {
  const ordered = [...runningWindows].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let coveredUntil = startedAtMs;
  for (const window of ordered) {
    if (window.endMs <= coveredUntil) continue;
    if (window.startMs > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, window.endMs);
    if (coveredUntil >= endedAtMs) return true;
  }
  return false;
}

function validContinuity(continuity: PaceContinuity, evidence: PaceEvidence): boolean {
  if (continuity.historyComplete !== true || typeof continuity.sourceEpoch !== "number" ||
      !Number.isSafeInteger(continuity.sourceEpoch) || continuity.sourceEpoch < 0) {
    return false;
  }
  if (!Array.isArray(continuity.runningWindows) || continuity.runningWindows.length === 0 ||
      !continuity.runningWindows.every(validWindow) ||
      !coversHostWindow(continuity.runningWindows, evidence.startedAtMs, evidence.endedAtMs)) {
    return false;
  }
  if (!Array.isArray(continuity.competingActionWindows) ||
      !continuity.competingActionWindows.every(validWindow) ||
      continuity.competingActionWindows.some(window => overlaps(window, {startMs: evidence.startedAtMs, endMs: evidence.endedAtMs}))) {
    return false;
  }
  return true;
}

function validEvidence(evidence: PaceEvidence): boolean {
  if (!evidence || typeof evidence.turnId !== "string" || evidence.turnId.length === 0 ||
      typeof evidence.actionId !== "string" || evidence.actionId.length === 0 ||
      typeof evidence.signature !== "string" || evidence.signature.length === 0 ||
      typeof evidence.project !== "string" || evidence.project.length === 0 ||
      !finite(evidence.startedAtMs) || !finite(evidence.endedAtMs) || evidence.endedAtMs <= evidence.startedAtMs ||
      !Array.isArray(evidence.files) || evidence.files.length === 0 || evidence.files.length > MAX_FILES) {
    return false;
  }
  const identities = new Set<string>();
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const file of evidence.files) {
    if (!file || typeof file.identity !== "string" || file.identity.length === 0 || identities.has(file.identity) ||
        !finite(file.startMs) || !finite(file.endMs) || file.endMs <= file.startMs ||
        file.startMs < evidence.startedAtMs || file.endMs > evidence.endedAtMs || file.startMs < previousEnd) {
      return false;
    }
    identities.add(file.identity);
    previousEnd = file.endMs;
  }
  return true;
}

function invocationKey(evidence: PaceEvidence): string {
  return JSON.stringify([evidence.signature, evidence.turnId, evidence.actionId]);
}

function identityKey(evidence: PaceEvidence, identity: string): string {
  const normalized = resolve(evidence.project, identity.replaceAll("\\", "/"));
  return JSON.stringify([process.platform === "win32" ? normalized.toLowerCase() : normalized]);
}

function intervalsFor(evidence: PaceEvidence, identities: readonly string[]): PaceInterval[] {
  const selected = new Set(identities);
  const originMs = evidence.startedAtMs;
  return evidence.files.filter(file => selected.has(file.identity)).map(file => ({
    workClass: "file_processing",
    unit: "file",
    startActiveSeconds: (file.startMs - originMs) / 1000,
    endActiveSeconds: (file.endMs - originMs) / 1000,
    completedUnits: 1,
    complete: true,
    serial: true
  }));
}

function snapshotGroup(group: StoredGroup): PaceGroup {
  const intervals = [...group.intervals]
    .sort((left, right) => right.endActiveSeconds - left.endActiveSeconds || right.startActiveSeconds - left.startActiveSeconds)
    .slice(0, MAX_SNAPSHOT_INTERVALS)
    .sort((left, right) => left.startActiveSeconds - right.startActiveSeconds || left.endActiveSeconds - right.endActiveSeconds)
    .map(interval => ({...interval}));
  return {
    signature: group.signature,
    project: group.project,
    workClass: "file_processing",
    unit: "file",
    intervals
  };
}

export class PaceMeasurements {
  private readonly scopes = new Map<object, ScopeState>();

  ingest(scope: object, parsed: PaceEvidence, continuity: PaceContinuity): void {
    if (continuity.sourceEpoch === null || continuity.historyComplete !== true) {
      this.clear(scope);
      return;
    }

    let state = this.scopes.get(scope);
    if (state === undefined || state.sourceEpoch !== continuity.sourceEpoch) {
      state = {
        sourceEpoch: continuity.sourceEpoch,
        groups: new Map(),
        seenIdentities: new Set(),
        identityAdmissionDisabled: false
      };
      this.scopes.set(scope, state);
    }

    const key = validEvidence(parsed) ? invocationKey(parsed) : null;
    if (key === null || !validContinuity(continuity, parsed)) {
      if (key !== null) state.groups.delete(key);
      return;
    }

    const group = state.groups.get(key);
    const unseen = parsed.files.filter(file => !state!.seenIdentities.has(identityKey(parsed, file.identity)));
    if (unseen.length === 0) return;
    if (group !== undefined || unseen.length !== parsed.files.length) return;
    if (state.identityAdmissionDisabled || state.seenIdentities.size + unseen.length > MAX_IDENTITIES) {
      state.identityAdmissionDisabled = true;
      return;
    }
    if (!state.groups.has(key) && state.groups.size >= MAX_GROUPS) return;

    const freshGroup = {signature: parsed.signature, project: parsed.project, intervals: [] as PaceInterval[]};
    for (const file of unseen) state.seenIdentities.add(identityKey(parsed, file.identity));
    freshGroup.intervals.push(...intervalsFor(parsed, unseen.map(file => file.identity)));
    state.groups.set(key, freshGroup);
    if (state.seenIdentities.size >= MAX_IDENTITIES) state.identityAdmissionDisabled = true;
  }

  snapshot(scope: object): readonly PaceGroup[] {
    const state = this.scopes.get(scope);
    if (state === undefined) return [];
    return [...state.groups.values()]
      .filter(group => group.intervals.length >= 3)
      .map(snapshotGroup);
  }

  clear(scope: object): void {
    this.scopes.delete(scope);
  }
}
