export type ConversationRecordKind =
  | "user"
  | "assistant"
  | "tool_start"
  | "tool_result"
  | "runtime";

export type RuntimeState = "running" | "waiting" | "interrupted" | "failed";

export interface ConversationRecord {
  id: string;
  turnId: string | null;
  atMs: number;
  kind: ConversationRecordKind;
  text?: string;
  actionId?: string;
  assistantPhase?: 'commentary' | 'final';
  runtime?: RuntimeState;
}

export interface ReadBatch {
  records: ConversationRecord[];
  caughtUp: boolean;
  reset: boolean;
  partialLine: boolean;
  historyTruncated?: boolean;
}
