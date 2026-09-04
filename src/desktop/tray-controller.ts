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
  onSelectTask?(taskId: string): void | Promise<void>;
  onFollowActivity?(): void | Promise<void>;
  taskItems?: readonly { id: string; title: string; selected?: boolean }[];
  onExit(): void | Promise<void>;
  onError(error: unknown, action: string): void;
}

export interface TrayController {
  updateTasks?(tasks: readonly { id: string; title: string; selected?: boolean }[]): void;
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
  let taskItems = options.taskItems ?? [];
  const updateTasks = (tasks: readonly { id: string; title: string; selected?: boolean }[]): void => {
    taskItems = tasks;
    const template: TrayMenuItem[] = [
      { label: "Show HUD", click: () => invoke("Show HUD", options.onShow) },
      { label: "Hide HUD", click: () => invoke("Hide HUD", options.onHide) },
      { type: "separator" },
      ...(options.onFollowActivity === undefined ? [] : [
        { label: "Follow latest activity", click: () => invoke("Follow latest activity", options.onFollowActivity!) }
      ]),
      ...(options.onSelectTask === undefined ? [] : taskItems.map((task) => ({
        label: `Task: ${task.title}`,
        type: "checkbox" as const,
        checked: task.selected === true,
        click: () => invoke(`Select task ${task.id}`, () => options.onSelectTask!(task.id))
      }))),
      { label: "Diagnose", click: () => invoke("Diagnose", options.onDiagnose) },
      { type: "separator" },
      { label: "Exit", click: () => invoke("Exit", options.onExit) }
    ];
    options.tray.setContextMenu(options.buildMenu(template));
  };
  updateTasks(taskItems);
  return {
    updateTasks,
    dispose(): void {
      options.tray.destroy();
    }
  };
}
