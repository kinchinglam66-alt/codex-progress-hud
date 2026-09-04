import type { HudSnapshot } from "../server/task-store.js";

export interface RendererBootstrap {
  protocolVersion: number;
  generation: number;
}

export interface TaskMutationControllerOptions {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  getSnapshot(): HudSnapshot;
  setSnapshot(snapshot: HudSnapshot, shouldRender: boolean): void;
  loadBootstrap(): Promise<RendererBootstrap>;
}

function mutationHeaders(snapshot: HudSnapshot, bootstrap: RendererBootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-codex-progress-hud-protocol": String(bootstrap.protocolVersion),
    "x-codex-progress-hud-generation": String(bootstrap.generation),
    "x-codex-progress-hud-revision": String(snapshot.revision)
  };
}

async function staleRevision(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  try {
    const payload = await response.json() as { code?: unknown };
    return payload.code === "STALE_REVISION";
  } catch {
    return false;
  }
}

export function createTaskMutationController(options: TaskMutationControllerOptions): {
  mutate(path: string, body: unknown): Promise<void>;
} {
  let nextIntent = 0;
  let queue = Promise.resolve();

  const run = async (path: string, body: unknown, intent: number): Promise<void> => {
    const bootstrap = await options.loadBootstrap();
    let retried = false;
    for (;;) {
      const base = options.getSnapshot();
      const response = await options.fetch(path, {
        method: "POST",
        headers: mutationHeaders(base, bootstrap),
        body: JSON.stringify(body)
      });
      if (await staleRevision(response)) {
        if (retried || intent !== nextIntent) return;
        retried = true;
        const fresh = await options.fetch("/api/snapshot", { cache: "no-store" });
        if (!fresh.ok) return;
        const freshSnapshot = await fresh.json() as HudSnapshot;
        options.setSnapshot(freshSnapshot, intent === nextIntent);
        continue;
      }
      if (!response.ok || response.status === 204) return;
      const next = await response.json() as HudSnapshot;
      if (next.revision < options.getSnapshot().revision) return;
      options.setSnapshot(next, intent === nextIntent);
      return;
    }
  };

  return {
    mutate(path, body): Promise<void> {
      const intent = ++nextIntent;
      const operation = queue.then(() => run(path, body, intent));
      queue = operation.catch(() => undefined);
      return operation;
    }
  };
}
