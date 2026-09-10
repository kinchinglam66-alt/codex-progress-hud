export type ConversationRecordKind =
  | "user"
  | "assistant"
  | "tool_start"
  | "tool_result"
  | "runtime";

export type RuntimeState = "running" | "waiting" | "interrupted" | "failed";
export type RuntimeOutcome = "completed" | "interrupted" | "failed";

export interface ConversationRecord {
  id: string;
  turnId: string | null;
  atMs: number;
  kind: ConversationRecordKind;
  text?: string;
  actionId?: string;
  toolName?: string;
  cwd?: string;
  command?: string;
  complete?: boolean;
  exitCode?: number | null;
  startedAtMs?: number;
  endedAtMs?: number;
  output?: string;
  outputComplete?: boolean;
  assistantPhase?: 'commentary' | 'final';
  runtime?: RuntimeState;
  outcome?: RuntimeOutcome;
}

export interface ReadBatch {
  records: ConversationRecord[];
  caughtUp: boolean;
  reset: boolean;
  partialLine: boolean;
  historyTruncated?: boolean;
}
