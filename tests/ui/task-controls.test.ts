import { describe, expect, it } from "vitest";
import { taskButtonAccessibility } from "../../src/ui/task-controls.js";

describe("HUD task controls", () => {
  it("exposes selected state accessibly instead of relying on color or data attributes", () => {
    expect(taskButtonAccessibility({
      id: "task-a",
      title: "Alpha",
      statusLabel: "执行中",
      selected: true
    })).toEqual({
      "aria-pressed": "true",
      "aria-label": "Alpha · 执行中（当前任务）"
    });
    expect(taskButtonAccessibility({
      id: "task-b",
      title: "Beta",
      statusLabel: "空闲",
      selected: false
    })).toEqual({
      "aria-pressed": "false",
      "aria-label": "Beta · 空闲"
    });
  });
});
