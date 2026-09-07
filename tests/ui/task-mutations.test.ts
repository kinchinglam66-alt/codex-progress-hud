import { describe, expect, it, vi } from "vitest";
import type { HudSnapshot } from "../../src/server/task-store.js";
import { createTaskMutationController } from "../../src/ui/task-mutations.js";

const snapshot = (revision: number, selectedTaskId: string | null = "task-a"): HudSnapshot => ({
  revision,
  selectedTaskId,
  selectionMode: selectedTaskId === null ? "follow_activity" : "pinned",
  tasks: selectedTaskId === null ? [] : [
    { id: "task-a", title: "Alpha", status: "running", lastActivityAt: 100, hiddenForTask: false },
    { id: "task-b", title: "Beta", status: "running", lastActivityAt: 90, hiddenForTask: false }
  ],
  selected: null,
  compatibility: { incompatibleClientSeen: false }
});

function response(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("renderer task mutations", () => {
  it("sends protocol, generation, and revision headers for selection and visibility mutations", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      requests.push(init === undefined ? { path: input } : { path: input, init });
      return response(202, snapshot(2, "task-b"));
    });
    let current = snapshot(1);
    const controller = createTaskMutationController({
      fetch: fetcher,
      getSnapshot: () => current,
      setSnapshot: (next) => { current = next; },
      loadBootstrap: async () => ({ protocolVersion: 2, generation: 7 })
    });

    await controller.mutate("/api/tasks/task-b/select", { mode: "pinned" });
    await controller.mutate("/api/tasks/task-b/select", { mode: "follow_activity" });
    await controller.mutate("/api/tasks/task-a/visibility", { hidden: true });

    expect(requests.map(({ path }) => path)).toEqual([
      "/api/tasks/task-b/select",
      "/api/tasks/task-b/select",
      "/api/tasks/task-a/visibility"
    ]);
    expect(requests.map((request) => (request.init?.headers as Record<string, string>)["x-codex-progress-hud-revision"])).toEqual(["1", "2", "2"]);
    for (const request of requests) {
      expect(request.init?.headers).toMatchObject({
        "x-codex-progress-hud-protocol": "2",
        "x-codex-progress-hud-generation": "7",
      });
    }
  });

  it("serializes rapid intents and never lets an older response render over the newest intent", async () => {
    const firstResponse = (() => {
      let resolve!: (value: Response) => void;
      const promise = new Promise<Response>((ready) => { resolve = ready; });
      return { promise, resolve };
    })();
    const rendered: HudSnapshot[] = [];
    let current = snapshot(1);
    const fetcher = vi.fn((input: string) => {
      if (input.endsWith("task-a/select")) return firstResponse.promise;
      return Promise.resolve(response(202, snapshot(3, "task-b")));
    });
    const controller = createTaskMutationController({
      fetch: fetcher,
      getSnapshot: () => current,
      setSnapshot: (next, shouldRender) => {
        current = next;
        if (shouldRender) rendered.push(next);
      },
      loadBootstrap: async () => ({ protocolVersion: 2, generation: 7 })
    });

    const first = controller.mutate("/api/tasks/task-a/select", { mode: "pinned" });
    const second = controller.mutate("/api/tasks/task-b/select", { mode: "pinned" });
    firstResponse.resolve(response(202, snapshot(2, "task-a")));
    await Promise.all([first, second]);

    expect(fetcher.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[1]!);
    expect(rendered.at(-1)?.selectedTaskId).toBe("task-b");
    expect(rendered.some((value) => value.selectedTaskId === "task-a")).toBe(false);
  });

  it("refreshes once before retrying only STALE_REVISION and does not retry other 409 responses", async () => {
    let current = snapshot(1);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(409, { code: "STALE_REVISION", revision: 2 }))
      .mockResolvedValueOnce(response(200, snapshot(2, "task-a")))
      .mockResolvedValueOnce(response(202, snapshot(3, "task-b")));
    const controller = createTaskMutationController({
      fetch: fetcher,
      getSnapshot: () => current,
      setSnapshot: (next) => { current = next; },
      loadBootstrap: async () => ({ protocolVersion: 2, generation: 7 })
    });

    await controller.mutate("/api/tasks/task-b/select", { mode: "pinned" });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/snapshot");
    expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({
      "x-codex-progress-hud-revision": "2"
    });

    fetcher.mockReset();
    fetcher.mockResolvedValueOnce(response(409, { code: "GENERATION_REJECTED" }));
    await controller.mutate("/api/tasks/task-b/select", { mode: "pinned" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
