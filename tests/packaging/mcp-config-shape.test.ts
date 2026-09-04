import { describe, expect, it } from "vitest";
import { requireWrappedMcpServers } from "../../scripts/mcp-config-shape.mjs";

describe("MCP configuration shape", () => {
  it("accepts the wrapped server map", () => {
    const servers = requireWrappedMcpServers({
      mcpServers: { "codex-progress-hud": { command: "launcher.exe" } }
    }, "root .mcp.json");

    expect(servers["codex-progress-hud"]).toEqual({ command: "launcher.exe" });
  });

  it("rejects a stale direct mapping even when a wrapped map is also present", () => {
    expect(() => requireWrappedMcpServers({
      mcpServers: { "codex-progress-hud": { command: "launcher.exe" } },
      "codex-progress-hud": { command: "legacy.exe" }
    }, "release .mcp.json")).toThrow(/only the mcpServers top-level key/u);
  });
});
