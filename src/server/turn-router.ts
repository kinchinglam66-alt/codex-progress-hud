import type { ProgressEnvelope } from '../core/schema.js';
import type { HookEnvelope } from '../hooks/schema.js';

export type TurnRoute =
  | { kind: 'ignored'; reason: 'duplicate' | 'expired_turn' }
  | { kind: 'degraded'; reason: 'turn_identity_unavailable' | 'turn_order_unknown' | 'turn_capacity_reached' | 'turn_identity_conflict' }
  | { kind: 'session'; sessionKey: string; ended: boolean }
  | { kind: 'apply'; envelope: ProgressEnvelope; sessionKey: string; turnKey: string;
      follow: boolean; lateAttached: boolean; orderingUncertain: boolean };

interface TurnRecord {
  sessionKey: string;
  turnKey: string;
  lastReceipt: number;
  terminalAt?: number;
  expired: boolean;
  events: Set<string>;
  terminals: Set<'Stop' | 'Interrupt'>;
  lateAttached: boolean;
  orderingUncertain: boolean;
  promptSeen: boolean;
  promptAnchor: string | undefined;
}

export function createTurnRouter(options: { maxTurns?: number; retentionMs?: number } = {}): {
  route(envelope: HookEnvelope, observedAt: number): TurnRoute
  takeover(sessionKey:string, previousTurnKey:string, turnKey:string, taskHandle:string, observedAt:number): void
  observeTerminal(taskHandle: string, observedAt: number): void
  hasIdentity(taskHandle: string): boolean
} {
  const maxTurns = options.maxTurns ?? 2048;
  const retentionMs = options.retentionMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 2048 ||
      !Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new RangeError('invalid turn router limits');
  // Identity tombstones remain bounded and are never silently evicted. At the
  // cap, new identities degrade rather than making forgotten old turns current.
  const records = new Map<string, TurnRecord>();
  const current = new Map<string, string>();
  const superseded = new Map<string, Set<string>>();
  return {
    hasIdentity(taskHandle) { return records.has(taskHandle); },
    takeover(sessionKey, previousTurnKey, turnKey, taskHandle, observedAt) {
      if (!Number.isSafeInteger(observedAt) || observedAt < 0 || !sessionKey || !previousTurnKey || !turnKey || !taskHandle) {
        throw new RangeError('invalid takeover');
      }
      let fence = superseded.get(sessionKey);
      if (!fence) { fence = new Set(); superseded.set(sessionKey, fence); }
      fence.add(previousTurnKey);
      while (fence.size > maxTurns) fence.delete(fence.values().next().value!);
      for (const record of records.values()) {
        if (record.sessionKey === sessionKey && record.turnKey === previousTurnKey) record.expired = true;
      }
      const existing = records.get(taskHandle);
      if (existing && (existing.sessionKey !== sessionKey || existing.turnKey !== turnKey)) throw new Error('takeover identity conflict');
      current.set(sessionKey,taskHandle);
      // A source takeover synchronizes ownership, but must not bypass the
      // router's identity cap. At capacity the new Hook degrades normally;
      // the durable superseded fence and expired old record still reject old
      // activity without forgetting an existing identity.
      if (existing || records.size < maxTurns) {
        records.set(taskHandle, existing ?? {sessionKey,turnKey,lastReceipt:0,events:new Set(),terminals:new Set(),expired:false,
          lateAttached:true,orderingUncertain:false,promptSeen:false,promptAnchor:current.get(sessionKey)});
      }
    },
    observeTerminal(taskHandle, observedAt) {
      if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new RangeError('invalid terminal clock');
      const record = records.get(taskHandle);
      if (record !== undefined) record.terminalAt ??= observedAt;
    },
    route(envelope, observedAt) {
      if (!Number.isSafeInteger(observedAt) || observedAt < 0 ||
          !Number.isSafeInteger(envelope.receivedAt) || envelope.receivedAt < 0 ||
          envelope.receivedAt > observedAt) throw new RangeError('invalid observation clock');
      const { sessionKey, turnKey, taskHandle, hook, receivedAt, eventId } = envelope;
      const terminal = hook === 'Stop' || hook === 'Interrupt' ? hook : undefined;
      if (hook === 'SessionStart' || hook === 'SessionEnd') {
        return { kind: 'session', sessionKey, ended: hook === 'SessionEnd' };
      }
      if (turnKey === undefined) return { kind: 'degraded', reason: 'turn_identity_unavailable' };
      if (superseded.get(sessionKey)?.has(turnKey)) return {kind:'ignored',reason:'expired_turn'};
      let record = records.get(taskHandle);
      if (record !== undefined && (record.sessionKey !== sessionKey || record.turnKey !== turnKey)) {
        return { kind: 'degraded', reason: 'turn_identity_conflict' };
      }
      if (record === undefined) {
        for (const known of records.values()) {
          if (known.sessionKey === sessionKey && known.turnKey === turnKey) {
            return { kind: 'degraded', reason: 'turn_identity_conflict' };
          }
        }
        if (hook !== 'UserPromptSubmit' && hook !== 'PostToolUse') {
          return { kind: 'degraded', reason: 'turn_order_unknown' };
        }
        if (records.size >= maxTurns) return { kind: 'degraded', reason: 'turn_capacity_reached' };
        const previous = current.get(sessionKey);
        record = { sessionKey, turnKey, lastReceipt: receivedAt,
          events: new Set(), terminals: new Set(), expired: false, lateAttached: hook !== 'UserPromptSubmit',
          orderingUncertain: previous !== undefined, promptSeen: false, promptAnchor: previous };
        records.set(taskHandle, record);
        // Previously unseen activity cannot displace a prompt-associated turn.
        if (previous === undefined || hook === 'UserPromptSubmit') current.set(sessionKey, taskHandle);
      } else {
        if (record.expired || (record.terminalAt !== undefined && observedAt - record.terminalAt >= retentionMs)) {
          record.expired = true;
          return { kind: 'ignored', reason: 'expired_turn' };
        }
        if ((terminal === undefined && record.terminals.size > 0) ||
            record.events.has(eventId) || (terminal !== undefined && record.terminals.has(terminal)) ||
            (receivedAt < record.lastReceipt && hook !== 'Stop' && hook !== 'Interrupt' &&
              !(hook === 'UserPromptSubmit' && !record.promptSeen))) {
          return { kind: 'ignored', reason: 'duplicate' };
        }
      }
      // Activity saturation must not discard terminal evidence. One flag per
      // terminal kind keeps replay fencing bounded without evicting activity IDs.
      if (terminal === undefined && record.events.size >= 256) return { kind: 'degraded', reason: 'turn_capacity_reached' };
      // Tool delivery can precede the first prompt delivery. Honor that prompt
      // once under the existing prompt-receipt policy; never re-promote repeats.
      if (hook === 'UserPromptSubmit' && !record.promptSeen) {
        record.promptSeen = true;
        const selected=current.get(sessionKey);
        if(selected===taskHandle || selected===record.promptAnchor)current.set(sessionKey, taskHandle);
      }
      if (terminal !== undefined) record.terminals.add(terminal);
      else record.events.add(eventId);
      record.lastReceipt = Math.max(record.lastReceipt, receivedAt);
      const event: ProgressEnvelope['event'] = hook === 'UserPromptSubmit'
        ? { type: 'turn_started', turnId: turnKey }
        : hook === 'PostToolUse' ? { type: 'activity_seen', category: 'hook' }
        : hook === 'Stop' ? { type: 'turn_stopped' }
        : { type: 'runtime_interrupted' };
      return { kind: 'apply', envelope: { taskId: taskHandle, event }, sessionKey, turnKey,
        follow: current.get(sessionKey) === taskHandle, lateAttached: record.lateAttached,
        orderingUncertain: record.orderingUncertain };
    }
  };
}
