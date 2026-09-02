import { describe, expect, it } from "vitest";
import { selectEntryIntent, selectEntryMode } from "../../src/main.js";

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

  it("distinguishes automatic login from explicit HUD activation", () => {
    expect(selectEntryIntent(["app.exe", "--automatic-login"])).toEqual({
      mode: "hud",
      launchReason: "automatic-login"
    });
    expect(selectEntryIntent(["app.exe", "--hud"])).toEqual({
      mode: "hud",
      launchReason: "explicit"
    });
    expect(selectEntryIntent(["app.exe"])).toEqual({ mode: "hud", launchReason: "explicit" });
  });
});
