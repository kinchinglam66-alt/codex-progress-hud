import { afterEach, expect, it, vi } from "vitest";
import { createConnectionOwner } from "../../src/mcp/connection-owner.js";
afterEach(() => vi.useRealTimers());

it("retries without model work, coalesces start, and stops permanently", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  let stops = 0;
  const owner = createConnectionOwner({
    start: async () => { if (++attempts === 1) throw new Error("offline"); },
    stop: async () => { stops++; }
  });
  owner.start(); owner.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(attempts).toBe(2);
  await owner.stop(); await owner.stop(); owner.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(attempts).toBe(2);
  expect(stops).toBe(1);
});

it("does not overlap pending acquisition or reschedule after close", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  let attempts = 0;
  const owner = createConnectionOwner({
    start: () => { attempts++; return new Promise<void>(r => { finish = r; }); },
    stop: async () => undefined
  });
  owner.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(attempts).toBe(1);
  await owner.stop(); finish();
  await vi.advanceTimersByTimeAsync(60000);
  expect(attempts).toBe(1);
});
