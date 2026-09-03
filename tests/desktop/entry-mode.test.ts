import { describe, expect, it } from "vitest";
import { selectEntryIntent, selectEntryMode } from "../../src/main.js";

describe("executable entry mode", () => {
  it("selects MCP stdio mode only when its explicit flag is present", () => {
    expect(selectEntryMode(["app.exe", "--mcp-stdio"])).toBe("mcp-stdio");
  });

  it.each([
    "SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "Interrupt", "SessionEnd"
  ] as const)("selects Hook event mode for %s", (hookName) => {
    expect(selectEntryMode(["app.exe", `--hook-event=${hookName}`])).toBe("hook-event");
    expect(selectEntryIntent(["app.exe", `--hook-event=${hookName}`])).toEqual({
      mode: "hook-event",
      hookName
    });
  });

  it("selects HUD mode for the explicit HUD flag", () => {
    expect(selectEntryMode(["app.exe", "--hud"])).toBe("hud");
  });

  it("defaults to HUD mode", () => {
    expect(selectEntryMode(["app.exe"])).toBe("hud");
  });

  it("rejects the removed automatic-login entry instead of starting the HUD", () => {
    expect(() => selectEntryIntent(["app.exe", "--automatic-login"]))
      .toThrow("Automatic login is disabled");
    expect(selectEntryIntent(["app.exe", "--hud"])).toEqual({
      mode: "hud",
      launchReason: { kind: "explicit" }
    });
    expect(selectEntryIntent(["app.exe"])).toEqual({
      mode: "hud",
      launchReason: { kind: "explicit" }
    });
  });

  it.each([0, 7])("classifies safe manager generation %i as a non-explicit HUD launch", (generation) => {
    expect(selectEntryIntent(["app.exe", "--hud", `--manager-generation=${generation}`])).toEqual({
      mode: "hud",
      launchReason: { kind: "manager", generation }
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
    ["missing HUD marker", ["app.exe", "--manager-generation=7"]]
  ])("rejects manager generation combined with %s", (_name, argv) => {
    expect(() => selectEntryIntent(argv)).toThrow("Invalid manager launch arguments");
  });

  it.each([
    ["missing value", ["app.exe", "--hook-event"]],
    ["empty value", ["app.exe", "--hook-event="]],
    ["unknown event", ["app.exe", "--hook-event=Unknown"]],
    ["duplicate event", ["app.exe", "--hook-event=Stop", "--hook-event=Stop"]],
    ["mixed MCP mode", ["app.exe", "--hook-event=Stop", "--mcp-stdio"]],
    ["mixed HUD mode", ["app.exe", "--hook-event=Stop", "--hud"]]
  ])("rejects %s", (_name, argv) => {
    expect(() => selectEntryIntent(argv)).toThrow("Invalid hook event arguments");
  });
});
