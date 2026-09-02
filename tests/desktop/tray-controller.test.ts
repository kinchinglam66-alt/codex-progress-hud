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
      onExit: vi.fn(),
      onError: vi.fn()
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

  it("forwards an explicit login checkbox selection", async () => {
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
      onExit: vi.fn(),
      onError: vi.fn()
    });

    template[3]?.click?.({ checked: true });

    await vi.waitFor(() => expect(onToggleLogin).toHaveBeenCalledWith(true));
  });

  it("reports a synchronous tray callback throw without throwing from click", async () => {
    const failure = new Error("show failed");
    const onError = vi.fn();
    let template: TrayMenuItem[] = [];
    createTrayController({
      tray: { setContextMenu: vi.fn(), destroy: vi.fn() },
      buildMenu: (received) => {
        template = received;
        return {};
      },
      loginEnabled: false,
      onShow: () => { throw failure; },
      onHide: vi.fn(),
      onToggleLogin: vi.fn(),
      onDiagnose: vi.fn(),
      onExit: vi.fn(),
      onError
    });

    expect(() => template[0]?.click?.({ checked: false })).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure, "Show HUD"));
  });

  it("reports an asynchronous tray callback rejection", async () => {
    const failure = new Error("hide failed");
    const onError = vi.fn();
    let template: TrayMenuItem[] = [];
    createTrayController({
      tray: { setContextMenu: vi.fn(), destroy: vi.fn() },
      buildMenu: (received) => {
        template = received;
        return {};
      },
      loginEnabled: false,
      onShow: vi.fn(),
      onHide: async () => { throw failure; },
      onToggleLogin: vi.fn(),
      onDiagnose: vi.fn(),
      onExit: vi.fn(),
      onError
    });

    template[1]?.click?.({ checked: false });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure, "Hide HUD"));
  });

  it.each([
    ["Show HUD", 0, "onShow", false],
    ["Hide HUD", 1, "onHide", true],
    ["Start with Windows", 3, "onToggleLogin", false],
    ["Diagnose", 4, "onDiagnose", true],
    ["Exit", 6, "onExit", false]
  ] as const)("contains every %s action failure through the shared wrapper", async (
    action,
    index,
    callbackName,
    asynchronous
  ) => {
    const failure = new Error(`${action} failed`);
    const onError = vi.fn();
    let template: TrayMenuItem[] = [];
    const callbacks = {
      onShow: vi.fn(),
      onHide: vi.fn(),
      onToggleLogin: vi.fn(),
      onDiagnose: vi.fn(),
      onExit: vi.fn()
    };
    callbacks[callbackName].mockImplementation(() => {
      if (asynchronous) return Promise.reject(failure);
      throw failure;
    });
    createTrayController({
      tray: { setContextMenu: vi.fn(), destroy: vi.fn() },
      buildMenu: (received) => { template = received; return {}; },
      loginEnabled: false,
      ...callbacks,
      onError
    });

    expect(() => template[index]?.click?.({ checked: true })).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure, action));
  });
});
