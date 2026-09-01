import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { scheduleAfterReady } from "./lifecycle.js";
import { createProgressServer } from "../server/http-server.js";
import { defaultTokenPath } from "../server/paths.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const tokenPath = defaultTokenPath();
const port = Number.parseInt(process.env.CODEX_PROGRESS_HUD_PORT ?? "17837", 10);
const progressServer = createProgressServer({
  port: Number.isFinite(port) ? port : 17_837,
  tokenPath,
  uiDirectory: resolve(currentDirectory, "../ui")
});

async function createWindow(): Promise<BrowserWindow> {
  await progressServer.listen();
  const { url } = progressServer.address();
  const token = (await readFile(tokenPath, "utf8")).trim();
  const window = new BrowserWindow({
    width: 340,
    height: 146,
    minWidth: 300,
    minHeight: 130,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`${url}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` }
      });
    }
  );
  window.setAlwaysOnTop(true, "floating");
  window.once("ready-to-show", () => window.showInactive());
  await window.loadURL(url);
  return window;
}

scheduleAfterReady(app.whenReady(), createWindow, (error) => {
  console.error("Codex Progress HUD failed to start", error);
  app.exit(1);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => void progressServer.close());
