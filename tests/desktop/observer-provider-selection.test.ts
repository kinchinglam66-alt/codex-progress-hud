import { describe, expect, it, vi } from "vitest";
import { createProviderSelection, type ProviderOwner } from "../../src/desktop/observer-provider-selection.js";
import type { ProviderConfig } from "../../src/desktop/observer-provider-config.js";

const api = {
  profileId: "api-1", name: "Synthetic", baseUrl: "https://example.test/v1", protocol: "responses" as const,
  model: "synthetic", keyRef: "opaque-ref", maxOutputTokens: 2048, dailyCallLimit: 24,
};
const config = (selected: ProviderConfig["selected"]): ProviderConfig => ({version: 1, selected, api: selected === "api" ? api : null});
const owner = (label: string): ProviderOwner => ({
  close: vi.fn(async () => undefined),
  inspect: vi.fn(async () => ({label, fingerprint: `${label}-fingerprint`})),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

describe("provider selection", () => {
  it("invalidates the old generation and drains before opening the replacement", async () => {
    const old = owner("old");
    const next = owner("next");
    const oldClosed = deferred<void>();
    old.close = vi.fn(() => oldClosed.promise);
    const open = vi.fn()
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(next);
    const persist = vi.fn(async () => undefined);
    const selection = createProviderSelection({open, persist});

    await selection.select(config("subscription"), new AbortController().signal);
    const oldGeneration = selection.status().generation;
    const switching = selection.select(config("api"), new AbortController().signal);

    expect(selection.accepts(oldGeneration)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(selection.status().state).toBe("switching");
    oldClosed.resolve();
    await switching;

    expect(open).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith(config("api"));
    expect(selection.status().state).toBe("ready");
    expect(selection.accepts(selection.status().generation)).toBe(true);
  });

  it("rejects a concurrent mutation without disturbing the active owner", async () => {
    const current = owner("current");
    const opening = deferred<ProviderOwner>();
    const selection = createProviderSelection({
      open: vi.fn().mockResolvedValueOnce(current).mockReturnValueOnce(opening.promise),
      persist: vi.fn(async () => undefined),
    });
    await selection.select(config("subscription"), new AbortController().signal);
    const switching = selection.select(config("api"), new AbortController().signal);
    await expect(selection.select(config("subscription"), new AbortController().signal)).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_BUSY");
    opening.resolve(owner("next"));
    await switching;
    expect(selection.status().state).toBe("ready");
  });

  it("does not reopen the old source after cancellation or an open failure", async () => {
    const old = owner("old");
    const open = vi.fn().mockResolvedValueOnce(old).mockRejectedValueOnce(new Error("private-open-detail"));
    const selection = createProviderSelection({open, persist: vi.fn(async () => undefined)});
    await selection.select(config("subscription"), new AbortController().signal);
    const generation = selection.status().generation;
    await expect(selection.select(config("api"), new AbortController().signal)).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_FAILED");
    expect(selection.status().state).toBe("failed");
    expect(selection.accepts(generation)).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
    expect(old.close).toHaveBeenCalledTimes(1);
  });

  it("leaves admission inactive when a switch is cancelled while the old owner drains", async () => {
    const old = owner("old");
    const oldClosed = deferred<void>();
    old.close = vi.fn(() => oldClosed.promise);
    const open = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(owner("next"));
    const selection = createProviderSelection({open, persist: vi.fn(async () => undefined)});
    await selection.select(config("subscription"), new AbortController().signal);
    const controller = new AbortController();
    const switching = selection.select(config("api"), controller.signal);
    controller.abort();
    oldClosed.resolve();
    await expect(switching).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_CANCELLED");
    expect(open).toHaveBeenCalledTimes(1);
    expect(selection.status().state).toBe("inactive");
    expect(selection.accepts(selection.status().generation)).toBe(false);
  });

  it("holds a late opened owner until its cleanup is confirmed before accepting another selection", async () => {
    const late = owner("late");
    const opened = deferred<ProviderOwner>();
    const lateClosed = deferred<void>();
    late.close = vi.fn(() => lateClosed.promise);
    const open = vi.fn().mockReturnValueOnce(opened.promise).mockResolvedValueOnce(owner("next"));
    const selection = createProviderSelection({open, persist: vi.fn(async () => undefined)});
    const controller = new AbortController();
    const first = selection.select(config("api"), controller.signal);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    controller.abort();
    const second = selection.select(config("subscription"), new AbortController().signal);
    await expect(second).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_BUSY");
    opened.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
    lateClosed.resolve();
    await expect(first).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_CANCELLED");
    await selection.select(config("subscription"), new AbortController().signal);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("retains an owner when cleanup fails and lets close retry that cleanup", async () => {
    const late = owner("late");
    const opened = deferred<ProviderOwner>();
    let closeAttempts = 0;
    late.close = vi.fn(async () => {
      closeAttempts += 1;
      if (closeAttempts <= 2) throw new Error("private-close-detail");
    });
    const selection = createProviderSelection({open: vi.fn().mockReturnValue(opened.promise), persist: vi.fn(async () => undefined)});
    const controller = new AbortController();
    const switching = selection.select(config("api"), controller.signal);
    await vi.waitFor(() => expect(selection.status().state).toBe("switching"));
    controller.abort();
    opened.resolve(late);
    await expect(switching).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_FAILED");
    expect(selection.status().state).toBe("failed");
    await expect(selection.select(config("subscription"), new AbortController().signal)).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_CLEANUP_REQUIRED");
    await expect(selection.close()).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_CLOSE_FAILED");
    await selection.close();
    expect(closeAttempts).toBe(3);
  });

  it("does not discard a replacement whose inspect or persistence fails during cleanup", async () => {
    const next = owner("next");
    next.inspect = vi.fn(async () => { throw new Error("private-inspect-detail"); });
    let closeAttempts = 0;
    next.close = vi.fn(async () => {
      closeAttempts += 1;
      if (closeAttempts <= 2) throw new Error("private-close-detail");
    });
    const selection = createProviderSelection({open: vi.fn().mockResolvedValue(next), persist: vi.fn(async () => undefined)});
    await expect(selection.select(config("api"), new AbortController().signal)).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_FAILED");
    await expect(selection.select(config("subscription"), new AbortController().signal)).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_CLEANUP_REQUIRED");
    await expect(selection.close()).rejects.toThrow("OBSERVER_PROVIDER_SELECTION_CLOSE_FAILED");
    await selection.close();
    expect(closeAttempts).toBe(3);
  });
});
