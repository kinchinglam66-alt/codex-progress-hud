import { describe, expect, it } from "vitest";
import {
  createFallbackTaskHandle,
  resolveTaskAssociation
} from "../../src/mcp/task-association.js";

describe("MCP task association", () => {
  const fallbackTaskHandle = "hud_ZmFsbGJhY2staGFuZGxlLTEyMzQ";

  it("generates a schema-compatible content-free handle", () => {
    const handle = createFallbackTaskHandle(() => Buffer.alloc(24, 7));

    expect(handle).toMatch(/^hud_[A-Za-z0-9_-]{20,96}$/u);
  });

  it("prefers a validated explicit handle", () => {
    expect(resolveTaskAssociation("hud_aaaaaaaaaaaaaaaaaaaa", fallbackTaskHandle))
      .toEqual({ taskHandle: "hud_aaaaaaaaaaaaaaaaaaaa", source: "explicit" });
  });

  it("uses the MCP-process fallback only when the handle is absent", () => {
    expect(resolveTaskAssociation(undefined, fallbackTaskHandle))
      .toEqual({ taskHandle: fallbackTaskHandle, source: "mcp_lease" });
  });

  it("generates different handles across real calls", () => {
    expect(createFallbackTaskHandle()).not.toBe(createFallbackTaskHandle());
  });
});
