export interface TaskButtonItem {
  id: string;
  title: string;
  statusLabel: string;
  selected: boolean;
}

export function taskButtonAccessibility(item: TaskButtonItem): {
  "aria-pressed": string;
  "aria-label": string;
} {
  return {
    "aria-pressed": String(item.selected),
    "aria-label": `${item.title} · ${item.statusLabel}${item.selected ? "（当前任务）" : ""}`
  };
}
