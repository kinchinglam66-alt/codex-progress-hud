type SettingsState = 'normal' | 'warning' | 'cooldown' | 'blocked' | 'checking' | 'awaiting_confirmation' | 'probing' | 'recovered' | 'failed' | 'unconfigured' | 'unauthorized' | 'repair_environment';
interface SettingsStatus {state: SettingsState; revision: number; knownTokens: number; unknown: number; recoveryAllowed: boolean;nextEligibleAt?:number|null;cooldownUntil?:number|null;lastDiagnostic?: {stage:string;outcome:string;usagePresent:boolean;closureConfirmed:boolean;callReason?:string;processReason?:string;exitCode?:number|null;parserError?:string|null;elapsedMs?:number;errorCategories?:string[]}}
interface ProviderDraft {selected: 'subscription'|'api'; api: {profileId:string;name:string;baseUrl:string;protocol:string;model:string;reasoningEffort?:string;maxOutputTokens:number;dailyCallLimit:number}|null}
interface ProviderSettings {generation:number;revision:number;selected:'subscription'|'api';state:string;active:ProviderDraft;draft:ProviderDraft;keyConfigured:boolean;account?:{label:string;observedAt:number;expiresAt:number}|null;recipient?:string}
interface SettingsApi {
  getStatus(): Promise<SettingsStatus>; preflight(): Promise<SettingsStatus & {allowed: boolean; challenge?: string}>; confirm(revision: number, challenge: string): Promise<SettingsStatus>; revokeConsent(): Promise<SettingsStatus & {consentRevoked:boolean}>;
  readProviderSettings?(): Promise<ProviderSettings>; saveProviderSettings?(payload: unknown): Promise<ProviderSettings>; replaceSubscriptionAccount?(payload: unknown): Promise<{outcome:string}>;
  checkProvider?(payload: unknown): Promise<{ok:boolean;stage:string;message:string}>; trialProvider?(payload: unknown): Promise<ProviderSettings>; activateProvider?(payload: unknown): Promise<ProviderSettings>; cancelProviderAction?(): Promise<ProviderSettings>;
}
declare global { interface Window {codexProgressHudSettings?: SettingsApi} }

const api = window.codexProgressHudSettings;
const state = document.querySelector<HTMLElement>('#state')!;
const known = document.querySelector<HTMLElement>('#known-tokens')!;
const unknown = document.querySelector<HTMLElement>('#unknown-count')!;
const message = document.querySelector<HTMLElement>('#message')!;
const diagnostic = document.querySelector<HTMLElement>('#diagnostic');
const check = document.querySelector<HTMLButtonElement>('#check')!;
const recover = document.querySelector<HTMLButtonElement>('#recover')!;
const revoke = document.querySelector<HTMLButtonElement>('#revoke')!;
let revision = 0;
let challenge: string | undefined;

function render(value: SettingsStatus): void {
  if(diagnostic){
    const detail=value.lastDiagnostic;
    diagnostic.textContent=detail ? `最近试探（本次启动）：阶段 ${detail.stage}；结果 ${detail.outcome}；调用分类 ${detail.callReason??'unknown'}；用量${detail.usagePresent?'已返回':'未返回'}；资源清理${detail.closureConfirmed?'已确认':'未确认'}（不代表请求已发出）。` : '';
    if(detail?.processReason)diagnostic.textContent+=` 进程结果 ${detail.processReason}；退出码 ${detail.exitCode??'未知'}；解析 ${detail.parserError??'无错误'}；耗时 ${detail.elapsedMs??'未知'} ms；错误线索 ${detail.errorCategories?.join(', ')||'未识别'}（仅作排查线索）。`;
  }
  revision = value.revision;
  state.textContent = value.state==='cooldown'?'冷却中':value.state==='warning'?'用量警告（有未知记录）':value.state;
  const next=value.nextEligibleAt??value.cooldownUntil;
  message.textContent=value.state==='cooldown'?
    typeof next==='number'&&Number.isSafeInteger(next)&&next>=0&&next<=8640000000000000?
      `下次可尝试：${new Date(next).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}（仅在有任务时）`:
      '等待满足恢复条件；空闲时不会发起试探。':
    value.state==='warning'?'未知用量仍保留在账本中，后续调用受预算和自动恢复限制。':'';
  known.textContent = String(value.knownTokens);
  unknown.textContent = String(value.unknown);
  recover.disabled = challenge === undefined || !value.recoveryAllowed || value.state === 'checking' || value.state === 'probing' || value.state === 'awaiting_confirmation';
}

async function refresh(): Promise<void> {
  if (!api) { message.textContent = '设置接口不可用'; return; }
  try { render(await api.getStatus()); }
  catch { message.textContent = '无法读取本地设置状态'; }
}

check.addEventListener('click', () => {
  void (async () => {
    if (!api) return;
    message.textContent = '正在进行本地检查…';
    try { const result = await api.preflight(); challenge = result.challenge; render(result);
      if(result.state!=='cooldown'&&result.state!=='warning')message.textContent = result.allowed ? '检查完成，可以进行一次显式试探。' : '检查未通过，估时保持停用。'; }
    catch { message.textContent = '本地检查失败，估时保持停用。'; }
  })();
});

recover.addEventListener('click', () => {
  void (async () => {
    if (!api) return;
    recover.disabled = true;
    message.textContent = '等待本地确认…';
    try {
      if (challenge === undefined) throw new Error('SETTINGS_STALE_CHALLENGE');
      render(await api.confirm(revision, challenge));
      challenge = undefined;
      await refresh();
      message.textContent = '恢复试探完成。';
    }
    catch { challenge = undefined; await refresh(); message.textContent = '恢复试探失败；不会自动重试。'; }
  })();
});

revoke.addEventListener('click', () => {
  void (async () => {
    if (!api) return;
    revoke.disabled = true;
    challenge=undefined;recover.disabled=true;
    try { const result=await api.revokeConsent();render(result);message.textContent = result.consentRevoked?'估时授权已撤销。':'已取消撤销，授权未更改。'; }
    catch { await refresh();message.textContent = '撤销未完成；保存的授权记录可能仍然存在，请检查状态并重试。'; }
    finally { revoke.disabled = false; }
  })();
});

void refresh();

const providerApi = api?.readProviderSettings ? api : undefined;
const providerSource = document.querySelector<HTMLSelectElement>('#provider-source');
const profileId = document.querySelector<HTMLInputElement>('#api-profile-id');
const providerName = document.querySelector<HTMLInputElement>('#api-name');
const baseUrl = document.querySelector<HTMLInputElement>('#api-base-url');
const model = document.querySelector<HTMLInputElement>('#api-model');
const protocol = document.querySelector<HTMLSelectElement>('#api-protocol');
const reasoningEffort = document.querySelector<HTMLSelectElement>('#api-reasoning-effort');
const maxOutputTokens = document.querySelector<HTMLInputElement>('#api-max-output-tokens');
const dailyCallLimit = document.querySelector<HTMLInputElement>('#api-daily-call-limit');
const apiKey = document.querySelector<HTMLInputElement>('#api-key');
const keyState = document.querySelector<HTMLElement>('#api-key-state');
const dirty = document.querySelector<HTMLElement>('#provider-dirty');
const account = document.querySelector<HTMLElement>('#provider-account');
const accountTime = document.querySelector<HTMLElement>('#provider-account-time');
const recipient = document.querySelector<HTMLElement>('#provider-recipient');
const providerSave = document.querySelector<HTMLButtonElement>('#provider-save');
const providerCheck = document.querySelector<HTMLButtonElement>('#provider-check');
const providerTrial = document.querySelector<HTMLButtonElement>('#provider-trial');
const providerActivate = document.querySelector<HTMLButtonElement>('#provider-activate');
const providerCancel = document.querySelector<HTMLButtonElement>('#provider-cancel');
const login = document.querySelector<HTMLButtonElement>('#subscription-login');
const deviceLogin = document.querySelector<HTMLButtonElement>('#subscription-device-login');
const logout = document.querySelector<HTMLButtonElement>('#subscription-logout');
let providerSnapshot: ProviderSettings | undefined;
let providerBusy = false;

function providerDraftFromInputs(): ProviderDraft {
  if (providerSource?.value === 'subscription') return {selected: 'subscription', api: null};
  const effort=reasoningEffort?.value;
  return {selected: 'api', api: {profileId: profileId?.value.trim() ?? '', name: providerName?.value.trim() ?? '', baseUrl: baseUrl?.value.trim() ?? '', protocol: protocol?.value ?? '', model: model?.value.trim() ?? '', ...(effort ? {reasoningEffort: effort} : {}),
    maxOutputTokens: Number(maxOutputTokens?.value ?? 2048), dailyCallLimit: Number(dailyCallLimit?.value ?? 24)}};
}
function setProviderBusy(value: boolean): void {
  providerBusy = value;
  for (const control of [providerSave, providerCheck, providerTrial, providerActivate, login, deviceLogin, logout]) if (control) control.disabled = value;
  if (providerCancel) providerCancel.disabled = !value;
}
function renderProvider(value: ProviderSettings): void {
  providerSnapshot = value;
  const source = value.draft.selected;
  if (providerSource) providerSource.value = source;
  const draft = value.draft.api;
  if (draft) {
    if (profileId) profileId.value = draft.profileId; if (providerName) providerName.value = draft.name; if (baseUrl) baseUrl.value = draft.baseUrl;
    if (model) model.value = draft.model; if (protocol) protocol.value = draft.protocol; if (reasoningEffort) reasoningEffort.value = draft.reasoningEffort ?? 'medium';
    if (maxOutputTokens) maxOutputTokens.value = String(draft.maxOutputTokens); if (dailyCallLimit) dailyCallLimit.value = String(draft.dailyCallLimit);
    if (draft.protocol !== 'responses') message.textContent = '不支持的协议；请选择 Responses。';
  }
  if (keyState) keyState.textContent = value.keyConfigured ? '已配置（密钥不会显示）' : '未配置密钥';
  if (account) account.textContent = value.account?.label ?? '未登录订阅账户';
  if (accountTime) accountTime.textContent = value.account ? `观察时间：${new Date(value.account.observedAt).toLocaleString('zh-CN')}；有效至：${new Date(value.account.expiresAt).toLocaleString('zh-CN')}` : '—';
  if (recipient) recipient.textContent = value.recipient ?? '接收方待读取';
  if (dirty) dirty.textContent = '已保存';
}
function providerEnvelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {generation: providerSnapshot?.generation ?? 0, revision: providerSnapshot?.revision ?? 0, ...extra};
}
function markDirty(): void {
  if (dirty && providerSnapshot) dirty.textContent = JSON.stringify(providerDraftFromInputs()) === JSON.stringify(providerSnapshot.draft) ? '已保存' : '有未保存更改';
}
async function refreshProvider(): Promise<void> {
  if (!providerApi?.readProviderSettings) return;
  try { renderProvider(await providerApi.readProviderSettings()); } catch { message.textContent = '无法读取提供方设置'; }
}
async function providerAction(operation: () => Promise<unknown>, success: string): Promise<void> {
  if (providerBusy) return; setProviderBusy(true);
  try { await operation(); await refreshProvider(); message.textContent = success; }
  catch (error) { const text = error instanceof Error && error.message === 'SETTINGS_INVALID_REQUEST' ? '设置请求无效' : error instanceof Error && error.message === 'PROVIDER_ACTION_CANCELLED' ? '已取消账户操作。' : '提供方操作失败；估时保持停用。'; message.textContent = text; }
  finally { setProviderBusy(false); }
}
for (const control of [providerSource, profileId, providerName, baseUrl, model, protocol, reasoningEffort, maxOutputTokens, dailyCallLimit]) control?.addEventListener('input', markDirty);
providerSave?.addEventListener('click', () => void providerAction(async () => {
  if (!providerApi?.saveProviderSettings) return;
  const secret = apiKey?.value ?? ''; apiKey && (apiKey.value = '');
  await providerApi.saveProviderSettings(providerEnvelope({draft: providerDraftFromInputs(), ...(secret ? {secret} : {})}));
}, '草稿已保存；当前提供方未改变。'));
providerCheck?.addEventListener('click', () => void providerAction(async () => {
  const result = await providerApi?.checkProvider?.(providerEnvelope()); if (result && !result.ok) throw new Error('PROVIDER_CHECK_FAILED');
}, '连接检查完成；尚未运行推理。'));
providerTrial?.addEventListener('click', () => void providerAction(async () => { await providerApi?.trialProvider?.(providerEnvelope()); }, '合成试探已完成；当前估时保持停用，请显式启用提供方。'));
providerActivate?.addEventListener('click', () => void providerAction(async () => { await providerApi?.activateProvider?.(providerEnvelope({selected: providerSource?.value})); }, '提供方已启用。'));
providerCancel?.addEventListener('click', () => void providerAction(async () => { await providerApi?.cancelProviderAction?.(); }, '操作已取消；提供方保持停用。'));
async function subscriptionAction(action: 'login'|'device-auth'|'logout'): Promise<void> {
  await providerAction(async () => {
    const result = await providerApi?.replaceSubscriptionAccount?.(providerEnvelope({action}));
    if (result?.outcome === 'cancelled') throw new Error('PROVIDER_ACTION_CANCELLED');
  }, action === 'logout' ? '订阅账户已退出。' : '订阅账户已更新。').catch(error => { if (error instanceof Error && error.message === 'PROVIDER_ACTION_CANCELLED') message.textContent = '账户操作已取消或终止；请检查当前账户身份。'; else throw error; });
}
login?.addEventListener('click', () => void subscriptionAction('login'));
deviceLogin?.addEventListener('click', () => void subscriptionAction('device-auth'));
logout?.addEventListener('click', () => void subscriptionAction('logout'));
void refreshProvider();
