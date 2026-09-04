import { buildHudView } from "./view-model.js";
import type { HudSnapshot } from "../server/task-store.js";
import { createTaskMutationController, type RendererBootstrap } from "./task-mutations.js";
import { taskButtonAccessibility } from "./task-controls.js";

const elements = {
  shell: document.querySelector<HTMLElement>("#hud"),
  title: document.querySelector<HTMLElement>("#title"),
  status: document.querySelector<HTMLElement>("#status"),
  progress: document.querySelector<HTMLElement>("#progress"),
  progressFill: document.querySelector<HTMLElement>("#progress-fill"),
  progressText: document.querySelector<HTMLElement>("#progress-text"),
  eta: document.querySelector<HTMLElement>("#eta"),
  step: document.querySelector<HTMLElement>("#step"),
  updated: document.querySelector<HTMLElement>("#updated"),
  tasks: document.querySelector<HTMLElement>("#tasks"),
  follow: document.querySelector<HTMLButtonElement>("#follow"),
  compatibility: document.querySelector<HTMLElement>("#compatibility"),
  origin: document.querySelector<HTMLElement>("#origin"),
  confidence: document.querySelector<HTMLElement>("#confidence")
};

const EMPTY_SNAPSHOT: HudSnapshot = {
  revision: 0,
  selectedTaskId: null,
  selectionMode: "follow_activity",
  tasks: [],
  selected: null,
  compatibility: { incompatibleClientSeen: false }
};

let latestSnapshot: HudSnapshot = EMPTY_SNAPSHOT;

function render(snapshot: HudSnapshot): void {
  if (snapshot.revision < latestSnapshot.revision) return;
  latestSnapshot = snapshot;
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
  if (elements.compatibility) elements.compatibility.textContent = view.compatibilityBanner ?? "";
  if (elements.origin) elements.origin.textContent = view.trackingOriginLabel ?? "";
  if (elements.confidence) elements.confidence.textContent = view.confidenceLabel ?? "";
  if (elements.follow) {
    elements.follow.textContent = view.canFollowActivity ? "跟随最新活动" : "正在跟随活动";
    elements.follow.disabled = !view.canFollowActivity;
  }
  if (elements.tasks) {
    elements.tasks.replaceChildren(...view.taskItems.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-item";
      button.textContent = `${item.title} · ${item.statusLabel}`;
      button.dataset.selected = String(item.selected);
      const accessibility = taskButtonAccessibility(item);
      button.setAttribute("aria-pressed", accessibility["aria-pressed"]);
      button.setAttribute("aria-label", accessibility["aria-label"]);
      button.addEventListener("click", () => void mutateTask(`/api/tasks/${encodeURIComponent(item.id)}/select`, { mode: "pinned" }));
      return button;
    }));
  }
}

let bootstrapPromise: Promise<RendererBootstrap> | undefined;
async function loadBootstrap(): Promise<RendererBootstrap> {
  bootstrapPromise ??= (async () => {
    const response = await fetch("/api/bootstrap", { cache: "no-store" });
    if (!response.ok) throw new Error("HUD bootstrap unavailable");
    const bootstrap = await response.json() as { protocolVersion?: unknown; generation?: unknown };
    if (
      typeof bootstrap.protocolVersion !== "number" ||
      !Number.isSafeInteger(bootstrap.protocolVersion) ||
      typeof bootstrap.generation !== "number" ||
      !Number.isSafeInteger(bootstrap.generation) ||
      bootstrap.generation < 0
    ) throw new Error("HUD bootstrap is invalid");
    return { protocolVersion: bootstrap.protocolVersion, generation: bootstrap.generation };
  })();
  return bootstrapPromise;
}

const mutationController = createTaskMutationController({
  fetch: (input, init) => fetch(input, init),
  getSnapshot: () => latestSnapshot,
  setSnapshot: (snapshot, shouldRender) => {
    if (snapshot.revision < latestSnapshot.revision) return;
    latestSnapshot = snapshot;
    if (shouldRender) render(snapshot);
  },
  loadBootstrap
});

function mutateTask(path: string, body: unknown): Promise<void> {
  return mutationController.mutate(path, body).catch(() => undefined);
}

elements.follow?.addEventListener("click", () => void mutateTask(
  `/api/tasks/${encodeURIComponent(latestSnapshot.selectedTaskId ?? "")}/select`,
  { mode: "follow_activity" }
));

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
