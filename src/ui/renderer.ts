import { buildHudView, createConversationViewProjector, conversationActivityLabel } from "./view-model.js";
import { createConversationRenderer } from "./conversation-renderer.js";
import type { HudSnapshot } from "../server/task-store.js";
import {createHudDisplayClock, startDisplayTicker} from './display-clock.js';

const tasks = document.querySelector<HTMLElement>("#tasks")!;
const status = document.querySelector<HTMLElement>("#status")!;
const banner = document.querySelector<HTMLElement>("#compatibility")!;
const empty = document.querySelector<HTMLElement>("#empty")!;
const renderRows = createConversationRenderer(tasks);
const displayClock = createHudDisplayClock();
const projectRows = createConversationViewProjector();

function render(): void {
  const frame = displayClock.read();
  if (frame === null) return;
  const {snapshot, elapsedSeconds, connected, updatedKeys,displayedSeconds} = frame;
  const views = projectRows(snapshot.rows ?? [], elapsedSeconds, updatedKeys,displayedSeconds);
  renderRows(views);
  status.textContent = conversationActivityLabel(views);
  empty.hidden = views.length !== 0;
  empty.textContent = snapshot.rows === undefined ? "请同时更新插件与伴侣程序以显示多对话" : "等待任务活动";
  banner.textContent = connected ? buildHudView(snapshot).compatibilityBanner ?? ""
    : "连接中断，显示的是最后状态；正在重连";
}

const stopTicker = startDisplayTicker(render);
window.addEventListener('pagehide', stopTicker, {once: true});

document.querySelector("#hide-window")?.addEventListener("click", () => {
  void controlWindow("/api/window/hide").catch(() => { banner.textContent = "隐藏窗口失败，请检查伴侣程序连接"; });
});

document.querySelector("#open-settings")?.addEventListener("click", () => {
  void controlWindow("/api/window/settings").catch(() => { banner.textContent = "打开设置失败，请检查伴侣程序连接"; });
});

async function controlWindow(path: string): Promise<void> {
    const response = await fetch("/api/bootstrap", { cache: "no-store" });
    if (!response.ok) throw new Error("Bootstrap unavailable");
    const bootstrap = await response.json() as { protocolVersion?: unknown; generation?: unknown };
    if (typeof bootstrap.protocolVersion !== "number" || !Number.isSafeInteger(bootstrap.protocolVersion) ||
        typeof bootstrap.generation !== "number" || !Number.isSafeInteger(bootstrap.generation) ||
        bootstrap.generation < 0) throw new Error("Invalid bootstrap");
    const result = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-progress-hud-protocol": String(bootstrap.protocolVersion),
        "x-codex-progress-hud-generation": String(bootstrap.generation)
      },
      body: "{}"
    });
    if (!result.ok) throw new Error("Window action failed");
}

async function connect(): Promise<void> {
  let retryMs = 500;
  for (;;) {
    try {
      const response = await fetch("/api/events", { cache: "no-store" });
      if (!response.ok || response.body === null) throw new Error("Stream unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let first = true;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replaceAll("\r\n", "\n");
          if (buffer.length > 524_288) throw new Error("Stream frame too large");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const data = buffer.slice(0, boundary).split("\n")
              .filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
            if (data !== "") {
              if (displayClock.accept(JSON.parse(data) as HudSnapshot, first)) render();
              first = false;
              retryMs = 500;
            }
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } catch {
      // Keep the last rows, but never present them as a live connection.
    }
    banner.textContent = "连接中断，显示的是最后状态；正在重连";
    displayClock.disconnect();
    render();
    await new Promise(resolve => setTimeout(resolve, retryMs));
    retryMs = Math.min(10_000, retryMs * 2);
  }
}
void connect();
