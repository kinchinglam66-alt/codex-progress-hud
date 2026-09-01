import { describe, expect, it } from "vitest";
import { selectEntryMode } from "../../src/main.js";

describe("executable entry mode", () => {
  it("selects MCP stdio mode only when its explicit flag is present", () => {
    expect(selectEntryMode(["app.exe", "--mcp-stdio"])).toBe("mcp-stdio");
  });

  it("selects HUD mode for the explicit HUD flag", () => {
    expect(selectEntryMode(["app.exe", "--hud"])).toBe("hud");
  });

  it("defaults to HUD mode", () => {
    expect(selectEntryMode(["app.exe"])).toBe("hud");
  });
});
