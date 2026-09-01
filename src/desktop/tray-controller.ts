export interface TrayMenuItem {
  label?: string;
  type?: "separator" | "checkbox";
  checked?: boolean;
  click?: (item: { checked: boolean }) => void;
}

export interface TrayLike {
  setContextMenu(menu: unknown): void;
  destroy(): void;
}

export interface TrayControllerOptions {
  tray: TrayLike;
  buildMenu(template: TrayMenuItem[]): unknown;
  loginEnabled: boolean;
  onShow(): void | Promise<void>;
  onHide(): void | Promise<void>;
  onToggleLogin(enabled: boolean): void | Promise<void>;
  onDiagnose(): void | Promise<void>;
  onExit(): void | Promise<void>;
}

export interface TrayController {
  dispose(): void;
}

function invoke(callback: () => void | Promise<void>): void {
  void Promise.resolve(callback());
}

export function createTrayController(options: TrayControllerOptions): TrayController {
  const template: TrayMenuItem[] = [
    { label: "Show HUD", click: () => invoke(options.onShow) },
    { label: "Hide HUD", click: () => invoke(options.onHide) },
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: options.loginEnabled,
      click: (item) => invoke(() => options.onToggleLogin(item.checked))
    },
    { label: "Diagnose", click: () => invoke(options.onDiagnose) },
    { type: "separator" },
    { label: "Exit", click: () => invoke(options.onExit) }
  ];
  options.tray.setContextMenu(options.buildMenu(template));
  return {
    dispose(): void {
      options.tray.destroy();
    }
  };
}
