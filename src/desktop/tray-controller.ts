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
  onShow(): void | Promise<void>;
  onHide(): void | Promise<void>;
  onDiagnose(): void | Promise<void>;
  onExit(): void | Promise<void>;
  onError(error: unknown, action: string): void;
}

export interface TrayController {
  dispose(): void;
}

export function createTrayController(options: TrayControllerOptions): TrayController {
  const invoke = (action: string, callback: () => void | Promise<void>): void => {
    void Promise.resolve()
      .then(callback)
      .catch((error: unknown) => {
        try {
          options.onError(error, action);
        } catch {
          // Electron menu callbacks must never reject into the event loop.
        }
      });
  };
  const template: TrayMenuItem[] = [
    { label: "Show HUD", click: () => invoke("Show HUD", options.onShow) },
    { label: "Hide HUD", click: () => invoke("Hide HUD", options.onHide) },
    { type: "separator" },
    { label: "Diagnose", click: () => invoke("Diagnose", options.onDiagnose) },
    { type: "separator" },
    { label: "Exit", click: () => invoke("Exit", options.onExit) }
  ];
  options.tray.setContextMenu(options.buildMenu(template));
  return {
    dispose(): void {
      options.tray.destroy();
    }
  };
}
