import { describe, expect, it, vi } from "vitest";
import { createTrayController, type TrayMenuItem } from "../../src/desktop/tray-controller.js";

describe("createTrayController", () => {
  it("exposes task selection entries without companion controls", async () => {
    const template: TrayMenuItem[] = [];
    const onSelectTask = vi.fn();
    createTrayController({
      tray: { setContextMenu: vi.fn(), destroy: vi.fn() },
      buildMenu: (received) => { template.push(...received); return {}; },
      onShow: vi.fn(), onHide: vi.fn(), onDiagnose: vi.fn(), onExit: vi.fn(),
      onSelectTask, onFollowActivity: vi.fn(),
      taskItems: [{ id: "task-1", title: "Build", selected: true }], onError: vi.fn()
    });
    const task = template.find((item) => item.label === "Task: Build");
    task?.click?.({ checked: true });
    await vi.waitFor(() => expect(onSelectTask).toHaveBeenCalledWith("task-1"));
    expect(template.some((item) => item.label === "Start tracking" || item.label === "Stop tracking")).toBe(false);
  });

  it("checks exactly the task selected by the aggregate snapshot projection", () => {
    const template: TrayMenuItem[] = [];
    createTrayController({
      tray: { setContextMenu: vi.fn(), destroy: vi.fn() },
      buildMenu: (received) => { template.push(...received); return {}; },
      onShow: vi.fn(), onHide: vi.fn(), onDiagnose: vi.fn(), onExit: vi.fn(),
      onSelectTask: vi.fn(),
      taskItems: [
        { id: "task-a", title: "Alpha", selected: false },
        { id: "task-b", title: "Beta", selected: true }
      ],
      onError: vi.fn()
    });

    expect(template.filter((item) => item.type === "checkbox").map((item) => item.checked)).toEqual([false, true]);
  });

  it("builds the tray without an automatic-login control", () => {
    const tray = { setContextMenu: vi.fn(), destroy: vi.fn() };
    let template: TrayMenuItem[] = [];

    createTrayController({
      tray,
      buildMenu: (received) => {
        template = received;
        return { kind: "menu" };
      },
      onShow: vi.fn(),
      onHide: vi.fn(),
      onDiagnose: vi.fn(),
      onSelectTask: vi.fn(),
      onFollowActivity: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn()
    });

    expect(
      template.map((item) => item.type === "separator" ? "separator" : item.label)
    ).toEqual([
      "Show HUD", "Hide HUD", "separator", "Follow latest activity", "Diagnose", "separator", "Exit"
    ]);
    expect(template.some((item) => item.label === "Start with Windows")).toBe(false);
    expect(tray.setContextMenu).toHaveBeenCalledWith({ kind: "menu" });
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
      onShow: () => { throw failure; },
      onHide: vi.fn(),
      onDiagnose: vi.fn(),
      onSelectTask: vi.fn(),
      onFollowActivity: vi.fn(),
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
      onShow: vi.fn(),
      onHide: async () => { throw failure; },
      onDiagnose: vi.fn(),
      onSelectTask: vi.fn(),
      onFollowActivity: vi.fn(),
      onExit: vi.fn(),
      onError
    });

    template[1]?.click?.({ checked: false });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure, "Hide HUD"));
  });

  it.each([
    ["Show HUD", 0, "onShow", false],
    ["Hide HUD", 1, "onHide", true],
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
      onDiagnose: vi.fn(),
      onSelectTask: vi.fn(),
      onFollowActivity: vi.fn(),
      onExit: vi.fn()
    };
    callbacks[callbackName].mockImplementation(() => {
      if (asynchronous) return Promise.reject(failure);
      throw failure;
    });
    createTrayController({
      tray: { setContextMenu: vi.fn(), destroy: vi.fn() },
      buildMenu: (received) => { template = received; return {}; },
      ...callbacks,
      onError
    });

    expect(() => template[index]?.click?.({ checked: true })).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure, action));
  });
});
