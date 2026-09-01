import { describe, expect, it, vi } from "vitest";
import { createTrayController, type TrayMenuItem } from "../../src/desktop/tray-controller.js";

describe("createTrayController", () => {
  it("builds the exact tray command order and reflects login state", () => {
    const tray = { setContextMenu: vi.fn(), destroy: vi.fn() };
    let template: TrayMenuItem[] = [];

    createTrayController({
      tray,
      buildMenu: (received) => {
        template = received;
        return { kind: "menu" };
      },
      loginEnabled: false,
      onShow: vi.fn(),
      onHide: vi.fn(),
      onToggleLogin: vi.fn(),
      onDiagnose: vi.fn(),
      onExit: vi.fn()
    });

    expect(
      template.map((item) => item.type === "separator" ? "separator" : item.label)
    ).toEqual([
      "Show HUD", "Hide HUD", "separator", "Start with Windows",
      "Diagnose", "separator", "Exit"
    ]);
    expect(template[3]).toMatchObject({ type: "checkbox", checked: false });
    expect(tray.setContextMenu).toHaveBeenCalledWith({ kind: "menu" });
  });

  it("forwards an explicit login checkbox selection", () => {
    const onToggleLogin = vi.fn();
    let template: TrayMenuItem[] = [];
    createTrayController({
      tray: { setContextMenu: vi.fn(), destroy: vi.fn() },
      buildMenu: (received) => {
        template = received;
        return {};
      },
      loginEnabled: false,
      onShow: vi.fn(),
      onHide: vi.fn(),
      onToggleLogin,
      onDiagnose: vi.fn(),
      onExit: vi.fn()
    });

    template[3]?.click?.({ checked: true });

    expect(onToggleLogin).toHaveBeenCalledWith(true);
  });
});
