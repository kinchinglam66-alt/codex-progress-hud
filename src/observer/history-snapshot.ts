import type {ConversationRecord} from "./conversation-record.js";

export type HistoryGap =
  | "upstream_truncated"
  | "unsupported_payload"
  | "unattributed_record"
  | "deduplication_window"
  | "unreadable_record";

export interface HistoryCoverage {
  complete: boolean;
  gaps: Array<HistoryGap>;
}

export interface HistoryRecord {
  ordinal: number;
  record: ConversationRecord;
}

export interface HistorySnapshot {
  // Local-only identities: never serialize these into provider messages.
  identity: string;
  sourceEpoch: number;
  revision: number;
  coverage: HistoryCoverage;
  // Each call opens a fresh reader over this snapshot's fixed watermark. The
  // iterator closes its page reader automatically; callers may replay the
  // snapshot for another planner pass until close() is called.
  records(signal: AbortSignal): AsyncIterable<HistoryRecord>;
  close(): Promise<void>;
}

export interface HistorySnapshotPage {
  records: ConversationRecord[];
  nextOffset: number;
  done: boolean;
  coverage: HistoryCoverage;
}

export interface HistorySnapshotReader {
  readPage(offset: number, signal: AbortSignal): Promise<HistorySnapshotPage>;
  close(): Promise<void>;
}

export interface HistorySnapshotSource {
  identity: string;
  sourceEpoch: number;
  revision: number;
  open(): HistorySnapshotReader;
  close(): Promise<void>;
}

function mergeCoverage(target: HistoryCoverage, page: HistoryCoverage): void {
  if (!page.complete) target.complete = false;
  for (const gap of page.gaps) {
    if (!target.gaps.includes(gap)) target.gaps.push(gap);
  }
}

function checkCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw snapshotError("source_cancelled", "history snapshot cancelled");
}

function snapshotError(code: string, message: string): Error & {code: string} {
  const error = new Error(message) as Error & {code: string};
  error.code = code;
  return error;
}

export function createHistorySnapshot(source: HistorySnapshotSource): HistorySnapshot {
  let closed = false;
  let encounteredIncompletePage = false;
  const coverage: HistoryCoverage = {
    // A snapshot is only authoritative after the iterator reaches its fixed watermark.
    complete: false,
    gaps: []
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await source.close();
  };

  async function* records(signal: AbortSignal): AsyncIterable<HistoryRecord> {
    if (closed) throw snapshotError("source_closed", "history snapshot is closed");
    const reader = source.open();
    let offset = 0;
    let ordinal = 0;
    try {
      while (!closed) {
        const page = await reader.readPage(offset, signal);
        if (!page.coverage.complete) encounteredIncompletePage = true;
        mergeCoverage(coverage, page.coverage);
        for (const record of page.records) {
          checkCancelled(signal);
          yield {ordinal, record};
          ordinal += 1;
        }
        if (page.done) {
          coverage.complete = !encounteredIncompletePage && coverage.gaps.length === 0 && page.coverage.complete;
          return;
        }
        if (page.nextOffset <= offset) {
          throw new Error("history snapshot reader made no progress");
        }
        offset = page.nextOffset;
      }
    } catch (error) {
      coverage.complete = false;
      throw error;
    } finally {
      await reader.close();
    }
  }

  return {
    identity: source.identity,
    sourceEpoch: source.sourceEpoch,
    revision: source.revision,
    coverage,
    records,
    close
  };
}
