import type {HudSnapshot} from '../server/task-store.js';

/** Local display interpolation only; never schedules inference or changes work state. */
export function createHudDisplayClock(now: () => number = () => performance.now()) {
  let snapshot: HudSnapshot | null = null;
  let receivedAt = 0;
  let elapsedSeconds = 0;
  let connected = false;
  const updatedUntil = new Map<string, number>();
  function advance() {
    if (connected) elapsedSeconds = Math.max(elapsedSeconds, (now() - receivedAt) / 1000, 0);
  }
  return {
    accept(frame: HudSnapshot, first: boolean): boolean {
      if (!first && snapshot !== null && frame.revision < snapshot.revision) return false;
      const timestamp = now();
      if (first) updatedUntil.clear();
      const previous = new Map((snapshot?.rows ?? []).map(row => [row.conversationKey, row.goal]));
      const present = new Set((frame.rows ?? []).map(row => row.conversationKey));
      for (const key of updatedUntil.keys()) if (!present.has(key)) updatedUntil.delete(key);
      if (!first) for (const row of frame.rows ?? []) {
        const before = previous.get(row.conversationKey), goal = row.goal;
        if (before && goal && goal.prediction !== null &&
            (before.estimateRevision !== goal.estimateRevision || before.generation !== goal.generation)) {
          updatedUntil.set(row.conversationKey, timestamp + 8000);
        }
      }
      snapshot = structuredClone(frame);
      receivedAt = timestamp; elapsedSeconds = 0; connected = true;
      return true;
    },
    disconnect(): void {advance(); connected = false;},
    read() {
      if (snapshot === null) return null;
      advance();
      const updatedKeys = [...updatedUntil].filter(([, until]) => now() < until).map(([key]) => key);
      return {snapshot, elapsedSeconds, connected, updatedKeys};
    }
  };
}

export function startDisplayTicker(render: () => void): () => void {
  const timer = setInterval(render, 1000);
  return () => clearInterval(timer);
}
