import type { ConversationName } from './conversation-projection.js';

interface Entry {
  hostId: string;
  name: ConversationName;
  attemptedAt: number;
  controller: AbortController;
  flight?: Promise<void>;
}
const unavailable = (): ConversationName => ({value:null, freshness:'unavailable'});
export function createConversationNames(
  readName: (hostId: string, signal: AbortSignal) => Promise<string | null>,
  options: { now?: () => number; maxEntries?: number; onChange?: () => void } = {}
) {
  const entries = new Map<string, Entry>();
  const now = options.now ?? Date.now;
  const max = options.maxEntries ?? 32;
  if(!Number.isSafeInteger(max) || max < 1 || max > 32) throw new RangeError('Invalid name cache capacity');
  let disabled = false;
  let tail = Promise.resolve();
  return {
    register(key: string, hostId: string): boolean {
      if(disabled || !key || key.length > 160 || !hostId || hostId.length > 256 || /[\x00-\x1f\x7f]/.test(hostId)) return false;
      const existing = entries.get(key);
      if(existing) return existing.hostId === hostId;
      if(entries.size >= max) return false;
      entries.set(key, {hostId,name:unavailable(),attemptedAt:-Infinity,controller:new AbortController()});
      return true;
    },
    get(key: string): ConversationName { return {...(entries.get(key)?.name ?? unavailable())}; },
    forget(key: string): void { entries.get(key)?.controller.abort(); entries.delete(key); },
    refresh(key: string): Promise<void> {
      const entry = entries.get(key);
      if(disabled || !entry) return Promise.resolve();
      if(entry.flight) return entry.flight;
      if(now() - entry.attemptedAt < 10000) return Promise.resolve();
      const run = async () => {
        if(disabled || entries.get(key) !== entry) return;
        entry.attemptedAt = now();
        let name: ConversationName;
        try {
          const value = await readName(entry.hostId, entry.controller.signal);
          const valid = typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 &&
            !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
          name = valid ? {value, freshness:'fresh'} :
            entry.name.value === null ? unavailable() : {...entry.name,freshness:'stale'};
        } catch { name = entry.name.value === null ? unavailable() : {...entry.name,freshness:'stale'}; }
        if(disabled || entry.controller.signal.aborted || entries.get(key) !== entry) return;
        if(name.value !== entry.name.value || name.freshness !== entry.name.freshness) {
          entry.name = name;
          try { options.onChange?.(); } catch { /* presentation cannot break the queue */ }
        }
      };
      entry.flight = tail.then(run).finally(() => { delete entry.flight; });
      tail = entry.flight.catch(() => undefined);
      return entry.flight;
    },
    disable(): void {
      disabled = true;
      for(const entry of entries.values()) entry.controller.abort();
      entries.clear();
    }
  };
}
