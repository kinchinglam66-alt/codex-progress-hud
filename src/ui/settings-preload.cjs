const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('codexProgressHudSettings', Object.freeze({
  getStatus: () => ipcRenderer.invoke('codex-progress-hud:settings:status'),
  preflight: () => ipcRenderer.invoke('codex-progress-hud:settings:preflight'),
  confirm: (revision, challenge) => ipcRenderer.invoke('codex-progress-hud:settings:confirm', {revision, challenge}),
  revokeConsent: () => ipcRenderer.invoke('codex-progress-hud:settings:revoke'),
  readProviderSettings: () => ipcRenderer.invoke('codex-progress-hud:settings:provider:read'),
  saveProviderSettings: (payload) => ipcRenderer.invoke('codex-progress-hud:settings:provider:save', payload),
  replaceSubscriptionAccount: (payload) => ipcRenderer.invoke('codex-progress-hud:settings:provider:account', payload),
  checkProvider: (payload) => ipcRenderer.invoke('codex-progress-hud:settings:provider:check', payload),
  trialProvider: (payload) => ipcRenderer.invoke('codex-progress-hud:settings:provider:trial', payload),
  activateProvider: (payload) => ipcRenderer.invoke('codex-progress-hud:settings:provider:activate', payload),
  startProvider: (payload) => ipcRenderer.invoke('codex-progress-hud:settings:provider:start', payload),
  cancelProviderAction: () => ipcRenderer.invoke('codex-progress-hud:settings:provider:cancel'),
}));
