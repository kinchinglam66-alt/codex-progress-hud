/** Connection liveness, never task progress or model work. */
export function createConnectionOwner(lifecycle: {
  start(): Promise<unknown>;
  stop(): Promise<void>;
}): { start(): void; stop(): Promise<void> } {
  let started = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (closed) return;
    try { await lifecycle.start(); } catch { /* retry while this connection lives */ }
    if (closed) return;
    timer = setTimeout(() => { void tick(); }, 10_000);
    timer.unref();
  };
  return {
    start() {
      if (started || closed) return;
      started = true;
      void tick();
    },
    async stop() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      await lifecycle.stop();
    }
  };
}
