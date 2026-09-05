import { afterEach, describe, expect, it, vi } from "vitest";

type CleanupOptions = {
  connect: () => Promise<void>;
  open: () => Promise<void>;
  work: (close: () => Promise<void>) => Promise<unknown>;
  close: () => Promise<void>;
  emergencyClose?: () => Promise<void>;
  release: () => Promise<void>;
  cleanup: () => Promise<void>;
  reportCleanupError?: (error: Error, context: string) => void;
};

type ToolResult = {
  isError?: boolean;
  structuredContent?: { ok?: boolean; observedState?: string };
};

type Removal = (
  path: string,
  options: { recursive: true; force: true }
) => Promise<void>;

type CleanupHelper = {
  runPackagedCleanup(options: CleanupOptions): Promise<unknown>;
  removeTemporaryDirectory(path: string, remove?: Removal): Promise<void>;
  assertToolSuccess(result: ToolResult, name: string): void;
  assertHudCloseStopped(result: ToolResult, context: string): void;
};

async function loadHelper(): Promise<CleanupHelper> {
  return await import("../../scripts/packaged-cleanup.mjs") as unknown as CleanupHelper;
}

async function runCleanup(options: CleanupOptions): Promise<unknown> {
  return (await loadHelper()).runPackagedCleanup(options);
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("preserves an open error when both primary and emergency close fail", async () => {
    const reports: string[] = [];
    const { events, options } = fixture({
      open: async () => {
        events.push("open");
        throw new Error("primary open failed");
      },
      close: async () => {
        events.push("close");
        throw new Error("primary close failed");
      },
      emergencyClose: async () => {
        events.push("emergency-close");
        throw new Error("emergency close failed");
      },
      reportCleanupError: (error, context) => {
        reports.push(`${context}: ${error.message}`);
      }
    });

    await expect(runCleanup(options)).rejects.toThrow("primary open failed");
    expect(events).toEqual([
      "connect", "open", "close", "emergency-close", "release", "cleanup"
    ]);
    expect(reports).toEqual(["primary HUD close: primary close failed", "emergency HUD close: emergency close failed"]);
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

  it("retries EBUSY removal through the independently derived bounded attempt count", async () => {
    const maximumAttempts = 16;
    const error = Object.assign(new Error("busy"), { code: "EBUSY" });
    let attempts = 0;
    const remove: Removal = async () => {
      attempts += 1;
      throw error;
    };

    vi.useFakeTimers();
    const removal = (await loadHelper()).removeTemporaryDirectory("temp", remove);
    const rejection = expect(removal).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejection;
    expect(attempts).toBe(maximumAttempts);
  });

  it("throws a non-retryable removal error immediately", async () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    let attempts = 0;
    const remove: Removal = async () => {
      attempts += 1;
      throw error;
    };

    await expect((await loadHelper()).removeTemporaryDirectory("temp", remove)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  it("exposes the retry-exhausted EBUSY error unchanged", async () => {
    const maximumAttempts = 16;
    const error = Object.assign(new Error("sharing violation"), { code: "EBUSY" });
    let attempts = 0;
    const remove: Removal = async () => {
      attempts += 1;
      throw error;
    };

    vi.useFakeTimers();
    const removal = (await loadHelper()).removeTemporaryDirectory("temp", remove);
    const rejection = expect(removal).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejection;
    expect(attempts).toBe(maximumAttempts);
  });

  it.each([
    ["isError", { isError: true, structuredContent: { ok: true, observedState: "stopped" } }],
    ["ok=false", { isError: false, structuredContent: { ok: false, observedState: "stopped" } }],
    ["wrong observedState", { isError: false, structuredContent: { ok: true, observedState: "running" } }]
  ])("rejects invalid primary hud_close result: %s", async (_caseName, result) => {
    const helper = await loadHelper();

    expect(() => helper.assertHudCloseStopped(result, "packaged")).toThrow();
  });

  it("accepts only a successful stopped primary hud_close result", async () => {
    const helper = await loadHelper();

    expect(() => helper.assertHudCloseStopped({
      isError: false,
      structuredContent: { ok: true, observedState: "stopped" }
    }, "packaged")).not.toThrow();
  });

  it("closes exactly once and exits cleanly on success", async () => {
    const { events, options } = fixture();

    await expect(runCleanup(options)).resolves.toBe("success");
    expect(events).toEqual(["connect", "open", "work", "close", "release", "cleanup"]);
    expect(events.filter((event) => event === "close")).toHaveLength(1);
    expect(events).not.toContain("emergency-close");
  });
});
