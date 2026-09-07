import type { PassiveContent } from "../hooks/passive-content.js";
import type { HookEnvelope, HookName } from "../hooks/schema.js";

export interface PassiveContextEntry {
  turnKey: string;
  hook: HookName;
  receivedAt: number;
  content: PassiveContent;
}

export interface PassiveContextView {
  sessionKey: string;
  sequence: number;
  entries: PassiveContextEntry[];
  truncated: boolean;
}

export interface PassiveContextStoreStats {
  conversations: number;
  entries: number;
  chars: number;
  eventIdentities: number;
  tombstones: number;
}

export interface PassiveContextStoreOptions {
  maxConversations?: number;
  maxEntries?: number;
  maxChars?: number;
}

type EnvelopeWithContent = HookEnvelope & { content?: PassiveContent };
type ContentKind = PassiveContent["kind"];

interface StoredEntry extends PassiveContextEntry {
  ingestionOrder: number;
}

interface Conversation {
  sessionKey: string;
  sequence: number;
  entries: StoredEntry[];
  truncated: boolean;
}

interface PruneResult {
  entries: StoredEntry[];
  truncated: boolean;
}

const DEFAULT_MAX_CONVERSATIONS = 32;
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_CHARS = 16_384;
const MAX_CONVERSATIONS = 128;
const MAX_ENTRIES = 128;
const MAX_CHARS = 65_536;
const MAX_CONTENT_CHARS = 4_096;
const MAX_EVENT_IDENTITIES = 4_096;

const expectedContentKind: Partial<Record<HookName, ContentKind>> = {
  UserPromptSubmit: "user",
  PostToolUse: "tool",
  Stop: "assistant"
};

const contentlessHooks = new Set<HookName>(["SessionStart", "Stop", "Interrupt", "SessionEnd"]);

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateOptions(options: PassiveContextStoreOptions): Required<PassiveContextStoreOptions> {
  const maxConversations = options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isSafeInteger(maxConversations) || maxConversations < 1 || maxConversations > MAX_CONVERSATIONS ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES ||
      !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_CHARS) {
    throw new RangeError("invalid passive context store limits");
  }
  return { maxConversations, maxEntries, maxChars };
}

function compareEntries(left: StoredEntry, right: StoredEntry): number {
  return left.receivedAt - right.receivedAt || left.ingestionOrder - right.ingestionOrder;
}

function contentChars(entries: StoredEntry[]): number {
  return entries.reduce((total, entry) => total + entry.content.text.length, 0);
}

export class PassiveContextStore {
  private readonly maxConversations: number;
  private readonly maxEntries: number;
  private readonly maxChars: number;
  private readonly conversations = new Map<string, Conversation>();
  private readonly eventIdentities = new Set<string>();
  private readonly tombstones = new Set<string>();
  private nextIngestionOrder = 0;

  constructor(options: PassiveContextStoreOptions = {}) {
    const limits = validateOptions(options);
    this.maxConversations = limits.maxConversations;
    this.maxEntries = limits.maxEntries;
    this.maxChars = limits.maxChars;
  }

  ingest(envelope: HookEnvelope, nowMs: number): boolean {
    const candidate = envelope as EnvelopeWithContent;
    if (!isSafeNonnegativeInteger(nowMs) ||
        !isSafeNonnegativeInteger(candidate.receivedAt) ||
        candidate.receivedAt > nowMs ||
        typeof candidate.sessionKey !== "string" || candidate.sessionKey.length === 0 ||
        typeof candidate.eventId !== "string" || candidate.eventId.length === 0 ||
        !this.acceptsContentShape(candidate)) {
      return false;
    }
    if (this.eventIdentities.has(candidate.eventId) || this.eventIdentities.size >= MAX_EVENT_IDENTITIES ||
        this.tombstones.has(candidate.sessionKey)) {
      return false;
    }

    if (candidate.hook === "SessionEnd") {
      if (!this.canCreateConversation(candidate.sessionKey)) return false;
      this.eventIdentities.add(candidate.eventId);
      this.conversations.delete(candidate.sessionKey);
      this.tombstones.add(candidate.sessionKey);
      return true;
    }

    const current = this.conversations.get(candidate.sessionKey);
    if (current === undefined && !this.canCreateConversation(candidate.sessionKey)) return false;

    const passiveContent = candidate.content;
    let pruned: PruneResult | undefined;
    const ingestionOrder = this.nextIngestionOrder + 1;
    if (passiveContent !== undefined) {
      if (typeof candidate.turnKey !== "string" || candidate.turnKey.length === 0) return false;
      const entry: StoredEntry = {
        turnKey: candidate.turnKey,
        hook: candidate.hook,
        receivedAt: candidate.receivedAt,
        content: {
          kind: passiveContent.kind,
          text: passiveContent.text,
          truncated: passiveContent.truncated
        },
        ingestionOrder
      };
      pruned = this.prune([...(current?.entries ?? []), entry], entry);
      if (pruned === undefined) return false;
    }

    const conversation = current ?? {
      sessionKey: candidate.sessionKey,
      sequence: 0,
      entries: [],
      truncated: false
    };
    if (pruned !== undefined) {
      conversation.entries = pruned.entries;
      conversation.truncated = conversation.truncated || pruned.truncated || passiveContent!.truncated;
    }
    conversation.sequence += 1;
    this.conversations.set(candidate.sessionKey, conversation);
    this.eventIdentities.add(candidate.eventId);
    this.nextIngestionOrder = ingestionOrder;
    return true;
  }

  read(sessionKey: string): PassiveContextView | null {
    const conversation = this.conversations.get(sessionKey);
    if (conversation === undefined) return null;
    return {
      sessionKey: conversation.sessionKey,
      sequence: conversation.sequence,
      entries: conversation.entries.map(entry => ({
        turnKey: entry.turnKey,
        hook: entry.hook,
        receivedAt: entry.receivedAt,
        content: {
          kind: entry.content.kind,
          text: entry.content.text,
          truncated: entry.content.truncated
        }
      })),
      truncated: conversation.truncated
    };
  }

  clear(): void {
    this.conversations.clear();
    this.eventIdentities.clear();
    this.tombstones.clear();
    this.nextIngestionOrder = 0;
  }

  remove(sessionKey: string): void {
    this.conversations.delete(sessionKey);
  }

  stats(): PassiveContextStoreStats {
    let entries = 0;
    let chars = 0;
    for (const conversation of this.conversations.values()) {
      entries += conversation.entries.length;
      chars += contentChars(conversation.entries);
    }
    return {
      conversations: this.conversations.size,
      entries,
      chars,
      eventIdentities: this.eventIdentities.size,
      tombstones: this.tombstones.size
    };
  }

  private acceptsContentShape(envelope: EnvelopeWithContent): boolean {
    const passiveContent = envelope.content;
    const expectedKind = expectedContentKind[envelope.hook];
    if (passiveContent === undefined) {
      return contentlessHooks.has(envelope.hook);
    }
    if (typeof passiveContent !== "object" || passiveContent === null || Array.isArray(passiveContent) ||
        expectedKind === undefined || passiveContent.kind !== expectedKind ||
        typeof passiveContent.text !== "string" || passiveContent.text.length > MAX_CONTENT_CHARS ||
        typeof passiveContent.truncated !== "boolean") {
      return false;
    }
    return true;
  }

  private canCreateConversation(sessionKey: string): boolean {
    return this.conversations.has(sessionKey) || this.tombstones.has(sessionKey) ||
      this.conversations.size + this.tombstones.size < this.maxConversations;
  }

  private prune(entries: StoredEntry[], newestEntry: StoredEntry): PruneResult | undefined {
    const retained = [...entries];
    let didPrune = false;
    while (retained.length > this.maxEntries || contentChars(retained) > this.maxChars) {
      const newestUserPrompt = retained
        .filter(entry => entry.content.kind === "user")
        .sort((left, right) => compareEntries(right, left))[0];
      const candidates = retained
        .filter(entry => entry !== newestUserPrompt)
        .sort(compareEntries);
      const oldest = candidates[0];
      if (oldest === undefined || oldest === newestEntry) return undefined;
      retained.splice(retained.indexOf(oldest), 1);
      didPrune = true;
    }
    retained.sort(compareEntries);
    return { entries: retained, truncated: didPrune };
  }
}
