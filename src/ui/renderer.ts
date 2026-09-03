import { buildHudView } from "./view-model.js";
import type { HudSnapshot } from "../server/task-store.js";

const elements = {
  shell: document.querySelector<HTMLElement>("#hud"),
  title: document.querySelector<HTMLElement>("#title"),
  status: document.querySelector<HTMLElement>("#status"),
  progress: document.querySelector<HTMLElement>("#progress"),
  progressFill: document.querySelector<HTMLElement>("#progress-fill"),
  progressText: document.querySelector<HTMLElement>("#progress-text"),
  eta: document.querySelector<HTMLElement>("#eta"),
  step: document.querySelector<HTMLElement>("#step"),
  updated: document.querySelector<HTMLElement>("#updated")
};

function render(snapshot: HudSnapshot): void {
  const view = buildHudView(snapshot);
  if (elements.shell) elements.shell.dataset.tone = view.tone;
  if (elements.title) elements.title.textContent = view.title;
  if (elements.status) elements.status.textContent = view.statusLabel;
  if (elements.progress) elements.progress.dataset.mode = view.progressMode;
  if (elements.progressFill) {
    elements.progressFill.style.width = `${view.progressPercent ?? 35}%`;
  }
  if (elements.progressText) {
    elements.progressText.textContent = view.progressPercent === null ? "" : `${view.progressPercent}%`;
  }
  if (elements.eta) elements.eta.textContent = view.etaLabel;
  if (elements.step) elements.step.textContent = view.stepLabel;
  if (elements.updated) elements.updated.textContent = view.updatedLabel;
}

const EMPTY_SNAPSHOT: HudSnapshot = {
  revision: 0,
  selectedTaskId: null,
  selectionMode: "follow_activity",
  tasks: [],
  selected: null,
  compatibility: { incompatibleClientSeen: false }
};

function consumeEventBlock(block: string): void {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("\n");
  if (data === "") return;
  render(JSON.parse(data) as HudSnapshot);
}

async function connect(): Promise<void> {
  let retryMs = 500;
  for (;;) {
    try {
      const response = await fetch("/api/events");
      if (!response.ok || response.body === null) throw new Error("HUD stream unavailable");
      retryMs = 500;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          consumeEventBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      render(EMPTY_SNAPSHOT);
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    retryMs = Math.min(10_000, retryMs * 2);
  }
}

void connect();
