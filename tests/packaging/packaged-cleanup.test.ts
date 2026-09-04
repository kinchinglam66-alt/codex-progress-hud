import { describe, expect, it } from "vitest";

type CleanupOptions = {
  connect: () => Promise<void>;
  open: () => Promise<void>;
  work: (close: () => Promise<void>) => Promise<unknown>;
  close: () => Promise<void>;
  emergencyClose?: () => Promise<void>;
  release: () => Promise<void>;
  cleanup: () => Promise<void>;
};

async function runCleanup(options: CleanupOptions): Promise<unknown> {
  const helper = await import("../../scripts/packaged-cleanup.mjs") as {
    runPackagedCleanup(options: CleanupOptions): Promise<unknown>;
  };
  return helper.runPackagedCleanup(options);
}

function fixture(overrides: Partial<CleanupOptions> = {}) {
  const events: string[] = [];
  const options: CleanupOptions = {
    connect: async () => { events.push("connect"); },
    open: async () => { events.push("open"); },
    work: async (close) => {
      events.push("work");
      await close();
      return "success";
    },
    close: async () => { events.push("close"); },
    emergencyClose: async () => { events.push("emergency-close"); },
    release: async () => { events.push("release"); },
    cleanup: async () => { events.push("cleanup"); },
    ...overrides
  };
  return { events, options };
}

describe("packaged cleanup orchestration", () => {
  it("attempts a primary close when open fails after MCP connects", async () => {
    const { events, options } = fixture({
      open: async () => {
        events.push("open");
        throw new Error("open failed");
      }
    });

    await expect(runCleanup(options)).rejects.toThrow("open failed");
    expect(events).toEqual(["connect", "open", "close", "release", "cleanup"]);
  });

  it("keeps a failed primary close as a failed command while attempting emergency cleanup", async () => {
    const { events, options } = fixture({
      close: async () => {
        events.push("close");
        throw new Error("primary close failed");
      }
    });

    await expect(runCleanup(options)).rejects.toThrow("primary close failed");
    expect(events).toEqual([
      "connect", "open", "work", "close", "emergency-close", "release", "cleanup"
    ]);
  });

  it("fails when temporary-directory cleanup fails", async () => {
    const { events, options } = fixture({
      cleanup: async () => {
        events.push("cleanup");
        throw new Error("temporary cleanup failed");
      }
    });

    await expect(runCleanup(options)).rejects.toThrow("temporary cleanup failed");
    expect(events).toEqual(["connect", "open", "work", "close", "release", "cleanup"]);
  });

  it("closes exactly once and exits cleanly on success", async () => {
    const { events, options } = fixture();

    await expect(runCleanup(options)).resolves.toBe("success");
    expect(events).toEqual(["connect", "open", "work", "close", "release", "cleanup"]);
    expect(events.filter((event) => event === "close")).toHaveLength(1);
    expect(events).not.toContain("emergency-close");
  });
});
