const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'dist', 'ui');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-settings-preload-'));
const preload = path.join(ui, 'settings-preload.cjs');
const html = path.join(ui, 'settings.html');
let window;
let preloadError = false;
const timeout = setTimeout(() => finish(2, {error: 'PRELOAD_SMOKE_TIMEOUT'}), 15_000);

function finish(code, result) {
  clearTimeout(timeout);
  try { window?.destroy(); } catch {}
  try { fs.rmSync(data, {recursive: true, force: true}); } catch {}
  console.log(JSON.stringify(result));
  app.exit(code);
}

app.setPath('userData', data);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  if (!fs.existsSync(preload) || !fs.existsSync(html)) return finish(2, {error: 'PRELOAD_SMOKE_ASSET_MISSING', preload, html});
  ipcMain.handle('codex-progress-hud:settings:status', () => ({state: 'blocked', revision: 1, knownTokens: 12, unknown: 1, recoveryAllowed: true}));
  window = new BrowserWindow({
    show: false,
    webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, preload}
  });
  window.webContents.on('preload-error', () => { preloadError = true; });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(JSON.stringify({didFailLoad: true, errorCode, errorDescription, validatedURL}));
  });
  window.webContents.on('console-message', (_event, _level, message) => { console.error(message); });
  window.webContents.on('render-process-gone', (_event, details) => { console.error(JSON.stringify({renderProcessGone: details})); });
  app.on('child-process-gone', (_event, details) => { console.error(JSON.stringify({childProcessGone: details})); });
  await window.loadFile(html);
  const status = await window.webContents.executeJavaScript(`(async () => {
    const api = window.codexProgressHudSettings;
    return {bridgePresent: !!api, status: api ? await api.getStatus() : null};
  })()`);
  finish(!preloadError && status.bridgePresent && status.status?.knownTokens === 12 ? 0 : 1,
    {preload: path.basename(preload), preloadError, ...status});
}).catch(error => finish(2, {error: error instanceof Error ? error.message : String(error)}));
