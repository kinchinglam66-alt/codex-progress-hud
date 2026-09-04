import { describe, expect, it } from "vitest";
import { buildHudView } from "../../src/ui/view-model.js";

describe("protocol mismatch integration", () => {
  it("shows an old-client mismatch independently from companion availability", () => {
    const view = buildHudView({
      revision: 1,
      selectedTaskId: null,
      selectionMode: "follow_activity",
      tasks: [],
      selected: null,
      compatibility: { incompatibleClientSeen: true }
    });
    expect(view.compatibilityBanner).toContain("版本不匹配");
    expect(view.statusLabel).not.toContain("离线");
  });
});
