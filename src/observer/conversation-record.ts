export type ConversationRecordKind =
  | "user"
  | "assistant"
  | "tool_start"
  | "tool_result"
  | "runtime";

export type RuntimeState = "running" | "waiting" | "interrupted" | "failed";
export type RuntimeOutcome = "completed" | "interrupted" | "failed";

/** Source content only: local references require validation before provider import. */
export type ConversationContentPart =
  | {type:'text';text:string}
  | {type:'local_image';path:string}
  | {type:'input_image';imageUrl:string};

export interface ConversationRecord {
  id: string;
  turnId: string | null;
  /** Explicit source attribution. Null means inferred/unknown; absent is legacy producer compatibility. */
  sourceTurnId?: string | null;
  /** Parser-attested conversation metadata, not a task/turn lifecycle signal. */
  sourceScope?: 'conversation';
  atMs: number;
  kind: ConversationRecordKind;
  text?: string;
  contentParts?: ConversationContentPart[];
  imageCount?:number;
  imageContextPending?:boolean;
  imageFingerprint?:string;
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
