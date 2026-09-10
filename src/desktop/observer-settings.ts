import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {ObserverRecoveryControllerStatus} from './observer-recovery.js';

export const SETTINGS_CHANNELS = Object.freeze({
  status: 'codex-progress-hud:settings:status',
  preflight: 'codex-progress-hud:settings:preflight',
  confirm: 'codex-progress-hud:settings:confirm',
  revoke: 'codex-progress-hud:settings:revoke',
  providerRead: 'codex-progress-hud:settings:provider:read',
  providerSave: 'codex-progress-hud:settings:provider:save',
  providerAccount: 'codex-progress-hud:settings:provider:account',
  providerCheck: 'codex-progress-hud:settings:provider:check',
  providerTrial: 'codex-progress-hud:settings:provider:trial',
  providerActivate: 'codex-progress-hud:settings:provider:activate',
  providerCancel: 'codex-progress-hud:settings:provider:cancel',
});

export interface SettingsBrowserWindowLike {
  webContents: {
    on(event: 'will-navigate', listener: (event: {preventDefault(): void}, url: string) => void): void;
    setWindowOpenHandler(handler: (details: {url: string}) => {action: 'deny'}): void;
  };
  on(event: 'close' | 'closed', listener: (event?: {preventDefault(): void}) => void): this;
  loadFile(path: string): Promise<unknown>;
  show(): void;
  focus(): void;
  hide(): void;
  isDestroyed(): boolean;
  destroy(): void;
}

interface SettingsWindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  show: boolean;
  resizable: boolean;
  webPreferences: {
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
    preload: string;
  };
}

interface SettingsIpcEvent {sender: unknown}
interface SettingsIpcMainLike {
  handle(channel: string, listener: (event: SettingsIpcEvent, payload?: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}
interface SettingsDialogLike {
  showMessageBox(options: {
    type: 'question'; title: string; message: string; detail: string;
    buttons: string[]; defaultId: number; cancelId: number; noLink: boolean;
  }): Promise<{response: number}>;
}

interface ProviderSettingsActions {
  readProviderSettings(): Promise<unknown>;
  saveProviderSettings(payload: unknown): Promise<unknown>;
  replaceSubscriptionAccount(payload: unknown): Promise<unknown>;
  checkProvider(payload: unknown): Promise<unknown>;
  trialProvider(payload: unknown): Promise<unknown>;
  activateProvider(payload: unknown): Promise<unknown>;
  cancelProviderAction(): Promise<unknown>;
  providerConsentRequired?(payload: unknown): Promise<boolean>;
}

export type SettingsStatus = ObserverRecoveryControllerStatus | (Omit<ObserverRecoveryControllerStatus, 'state'> & {state: 'unconfigured'});
export type SettingsPreflight = SettingsStatus & {allowed: boolean; challenge?: string};

const revisionPayload = z.object({revision: z.number().int().nonnegative().safe(), challenge: z.string().uuid()}).strict();
const CHALLENGE_TTL_MS = 30_000;

const WINDOW_OPTIONS: SettingsWindowOptions = {
  width: 560,
  height: 520,
  minWidth: 420,
  minHeight: 360,
  show: false,
  resizable: true,
  webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true, preload: ''},
};

export function createObserverSettingsController(options: {
  createWindow(windowOptions: SettingsWindowOptions): SettingsBrowserWindowLike;
  ipcMain: SettingsIpcMainLike;
  dialog: SettingsDialogLike;
  uiPath: string;
  preloadPath: string;
  quitting(): boolean;
  now?: () => number;
  readStatus(): SettingsStatus;
  preflight(): Promise<SettingsPreflight>;
  binding(): string | undefined;
  confirm(revision: number): Promise<SettingsStatus>;
  revokeConsent?: () => Promise<void>;
  provider?: ProviderSettingsActions;
}) {
  let window: SettingsBrowserWindowLike | undefined;
  let registered = false;
  let disposing = false;
  let windowGeneration = 0;
  let challenge: {value: string; sender: unknown; generation: number; revision: number; binding: string; expiresAt: number; consuming: boolean} | undefined;
  const now = options.now ?? Date.now;
  const providerMutation = z.object({generation: z.number().int().nonnegative().safe(), revision: z.number().int().nonnegative().safe()}).passthrough();
  const providerAccountPayload = z.object({generation: z.number().int().nonnegative().safe(), revision: z.number().int().nonnegative().safe(), action: z.enum(['login', 'device-auth', 'logout'] as const)}).strict();

  function invalidateChallenge(): void { challenge = undefined; }
  function activeChallenge(value: string, revision: number, sender: unknown): NonNullable<typeof challenge> {
    const current = challenge;
    const binding = options.binding();
    if (current === undefined || current.value !== value || current.sender !== sender || current.generation !== windowGeneration ||
        current.revision !== revision || current.binding !== binding || current.expiresAt < now() || current.consuming) throw new Error('SETTINGS_STALE_CHALLENGE');
    return current;
  }

  function trusted(event: SettingsIpcEvent): void {
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents) throw new Error('SETTINGS_UNTRUSTED_SENDER');
  }
  function registerHandlers(): void {
    if (registered) return;
    registered = true;
    options.ipcMain.handle(SETTINGS_CHANNELS.status, async event => { trusted(event); return options.readStatus(); });
    options.ipcMain.handle(SETTINGS_CHANNELS.preflight, async event => {
      trusted(event);
      const result = await options.preflight();
      if (!result.allowed) { invalidateChallenge(); return result; }
      const binding = options.binding();
      if (binding === undefined) { invalidateChallenge(); return {...result, allowed: false, state: 'repair_environment' as const}; }
      const value = randomUUID();
      challenge = {value, sender: event.sender, generation: windowGeneration, revision: result.revision, binding, expiresAt: now() + CHALLENGE_TTL_MS, consuming: false};
      return {...result, challenge: value};
    });
    options.ipcMain.handle(SETTINGS_CHANNELS.confirm, async (event, payload) => {
      trusted(event);
      const parsed = revisionPayload.safeParse(payload);
      if (!parsed.success) throw new Error('SETTINGS_INVALID_REQUEST');
      const status = options.readStatus();
      if (status.revision !== parsed.data.revision || !status.recoveryAllowed) throw new Error('SETTINGS_STALE_REVISION');
      const pending = activeChallenge(parsed.data.challenge, parsed.data.revision, event.sender);
      pending.consuming = true;
      const confirmation = await options.dialog.showMessageBox({
        type: 'question',
        title: 'Codex Progress HUD：显式恢复估时',
        message: '是否进行一次合成恢复试探？',
        detail: `历史未知用量次数：${status.unknown}。未知用量无法追回；本次最多调用一次模型，成功后才恢复日常估时。不会上传真实对话。`,
        buttons: ['确认并试探一次', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      trusted(event);
      if (challenge !== pending) throw new Error('SETTINGS_STALE_CHALLENGE');
      invalidateChallenge();
      if (confirmation.response !== 0) return options.readStatus();
      const latest = options.readStatus();
      if (latest.revision !== pending.revision || !latest.recoveryAllowed || options.binding() !== pending.binding) throw new Error('SETTINGS_STALE_CHALLENGE');
      return options.confirm(parsed.data.revision);
    });
    options.ipcMain.handle(SETTINGS_CHANNELS.revoke, async event => {
      trusted(event);
      const confirmation = await options.dialog.showMessageBox({
        type: 'question', title: 'Codex Progress HUD：撤销估时授权',
        message: '是否撤销估时授权？',
        detail: '撤销后会删除本机记住的估时授权并停止后续估时；已开始的请求仍会按现有会计记录完成结算。下次启用时需要重新确认。',
        buttons: ['撤销估时授权', '取消'], defaultId: 1, cancelId: 1, noLink: true,
      });
      trusted(event);
      if (confirmation.response !== 0) return {...options.readStatus(),consentRevoked:false};
      if(!options.revokeConsent)throw Error('SETTINGS_UNAVAILABLE');
      invalidateChallenge();
      await options.revokeConsent();
      return {...options.readStatus(),consentRevoked:true};
    });
    if (options.provider) {
      const provider = options.provider;
      options.ipcMain.handle(SETTINGS_CHANNELS.providerRead, async event => { trusted(event); return provider.readProviderSettings(); });
      options.ipcMain.handle(SETTINGS_CHANNELS.providerSave, async (event, payload) => {
        trusted(event); const parsed = providerMutation.safeParse(payload); if (!parsed.success) throw new Error('SETTINGS_INVALID_REQUEST'); return provider.saveProviderSettings(payload);
      });
      options.ipcMain.handle(SETTINGS_CHANNELS.providerAccount, async (event, payload) => {
        trusted(event); const parsed = providerAccountPayload.safeParse(payload); if (!parsed.success) throw new Error('SETTINGS_INVALID_REQUEST');
        if (parsed.data.action === 'login' || parsed.data.action === 'device-auth') {
          const confirmation = await options.dialog.showMessageBox({type: 'question', title: 'Codex Progress HUD：切换订阅账户', message: '是否开始订阅账户操作？', detail: '登录成功后仍需本机账户证明才会启用估时；取消按钮只在操作尚未开始时保持账户不变，开始后请以当前账户元数据为准。', buttons: ['继续', '取消'], defaultId: 1, cancelId: 1, noLink: true});
          trusted(event);
          if (confirmation.response !== 0) return {outcome: 'cancelled'};
        }
        return provider.replaceSubscriptionAccount(payload);
      });
      const confirmedProviderAction = (channel: string, operation: (payload: unknown) => Promise<unknown>, message: string, detail: string, disclosureRequired = false): void => {
        options.ipcMain.handle(channel, async (event, payload) => {
          trusted(event); const parsed = providerMutation.safeParse(payload); if (!parsed.success) throw new Error('SETTINGS_INVALID_REQUEST');
          const needsDisclosure=disclosureRequired&&provider.providerConsentRequired?await provider.providerConsentRequired(payload):disclosureRequired;
          if(!needsDisclosure)return operation(payload);
          const status=await provider.readProviderSettings();
          trusted(event);
          const recipient=typeof status==='object'&&status!==null&&typeof (status as {recipient?:unknown}).recipient==='string'?(status as {recipient:string}).recipient:'当前提供方';
          const confirmation = await options.dialog.showMessageBox({type: 'question', title: 'Codex Progress HUD：显式提供方操作', message, detail: `${detail} 数据接收方：${recipient}。`, buttons: ['继续', '取消'], defaultId: 1, cancelId: 1, noLink: true});
          trusted(event);
          if (confirmation.response !== 0) return provider.readProviderSettings();
          return operation(payload);
        });
      };
      confirmedProviderAction(SETTINGS_CHANNELS.providerCheck, provider.checkProvider, '是否检查 API 提供方？', '将向以下地址发送配置的 API 密钥以检查连接，不运行推理。', true);
      confirmedProviderAction(SETTINGS_CHANNELS.providerTrial, provider.trialProvider, '是否进行一次合成试探？', '这会暂时停止当前估时，但任务追踪仍会继续；会向所选提供方发送固定合成输入，可能产生费用；', true);
      confirmedProviderAction(SETTINGS_CHANNELS.providerActivate, provider.activateProvider, '是否启用所选提供方？', '启用后估时数据会发送给所示接收方；API 调用可能产生费用。保存草稿本身不会启用。', true);
      options.ipcMain.handle(SETTINGS_CHANNELS.providerCancel, async event => { trusted(event); return provider.cancelProviderAction(); });
    }
  }
  function removeHandlers(): void {
    if (!registered) return;
    registered = false;
    for (const channel of Object.values(SETTINGS_CHANNELS)) options.ipcMain.removeHandler(channel);
  }

  return {
    async open(): Promise<void> {
      if (window !== undefined && !window.isDestroyed()) { window.show(); window.focus(); return; }
      disposing = false;
      const settingsWindowOptions = {...WINDOW_OPTIONS, webPreferences: {...WINDOW_OPTIONS.webPreferences, preload: options.preloadPath}};
      const created = options.createWindow(settingsWindowOptions);
      window = created;
      windowGeneration++;
      invalidateChallenge();
      registerHandlers();
      created.webContents.on('will-navigate', event => event.preventDefault());
      created.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
      created.on('close', event => {
        if (disposing || options.quitting()) return;
        event?.preventDefault();
        created.hide();
      });
      created.on('closed', () => {
        if (window !== created) return;
        window = undefined;
        invalidateChallenge();
        removeHandlers();
      });
      try {
        await created.loadFile(options.uiPath);
        if (!options.quitting()) created.show();
      } catch (error) {
        window = undefined;
        removeHandlers();
        if (!created.isDestroyed()) created.destroy();
        throw error;
      }
    },
    async dispose(): Promise<void> {
      disposing = true;
      removeHandlers();
      const current = window;
      window = undefined;
      invalidateChallenge();
      if (current !== undefined && !current.isDestroyed()) current.destroy();
    },
    isOpen(): boolean { return window !== undefined && !window.isDestroyed(); },
  };
}
