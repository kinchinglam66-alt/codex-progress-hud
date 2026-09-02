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

  it.each([0, 7])("classifies safe manager generation %i as a non-explicit HUD launch", (generation) => {
    expect(selectEntryIntent(["app.exe", "--hud", `--manager-generation=${generation}`])).toEqual({
      mode: "hud",
      launchReason: "manager",
      generation
    });
  });

  it.each([
    ["missing value", ["app.exe", "--manager-generation"]],
    ["empty value", ["app.exe", "--manager-generation="]],
    ["negative value", ["app.exe", "--manager-generation=-1"]],
    ["fractional value", ["app.exe", "--manager-generation=1.5"]],
    ["unsafe value", ["app.exe", "--manager-generation=9007199254740992"]],
    ["duplicate value", ["app.exe", "--manager-generation=7", "--manager-generation=7"]]
  ])("rejects a %s instead of treating it as explicit activation", (_name, argv) => {
    expect(() => selectEntryIntent(argv)).toThrow("Invalid manager generation");
  });

  it.each([
    ["MCP stdio", ["app.exe", "--mcp-stdio", "--hud", "--manager-generation=7"]],
    ["automatic login", ["app.exe", "--automatic-login", "--hud", "--manager-generation=7"]],
    ["missing HUD marker", ["app.exe", "--manager-generation=7"]]
  ])("rejects manager generation combined with %s", (_name, argv) => {
    expect(() => selectEntryIntent(argv)).toThrow("Invalid manager launch arguments");
  });
});
