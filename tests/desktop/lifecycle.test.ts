import { describe, expect, it, vi } from "vitest";
import { scheduleAfterReady } from "../../src/desktop/lifecycle.js";

describe("desktop lifecycle", () => {
  it("finishes module setup before starting the window after readiness", async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const startWindow = vi.fn();

    expect(scheduleAfterReady(ready, startWindow)).toBeUndefined();
    expect(startWindow).not.toHaveBeenCalled();

    markReady();
    await ready;
    await Promise.resolve();

    expect(startWindow).toHaveBeenCalledOnce();
  });
});
