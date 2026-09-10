const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('codexProgressHudSettings', Object.freeze({
  getStatus: () => ipcRenderer.invoke('codex-progress-hud:settings:status'),
  preflight: () => ipcRenderer.invoke('codex-progress-hud:settings:preflight'),
  confirm: (revision, challenge) => ipcRenderer.invoke('codex-progress-hud:settings:confirm', {revision, challenge}),
  revokeConsent: () => ipcRenderer.invoke('codex-progress-hud:settings:revoke'),
}));
