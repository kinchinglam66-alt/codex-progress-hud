type SettingsState = 'normal' | 'warning' | 'cooldown' | 'blocked' | 'checking' | 'awaiting_confirmation' | 'probing' | 'recovered' | 'failed' | 'unconfigured' | 'unauthorized' | 'repair_environment';
interface SettingsStatus {state: SettingsState; reason?:string; revision: number; knownTokens: number; unknown: number; recoveryAllowed: boolean;nextEligibleAt?:number|null;cooldownUntil?:number|null;lastDiagnostic?: {stage:string;outcome:string;usagePresent:boolean;closureConfirmed:boolean;callReason?:string;processReason?:string;exitCode?:number|null;parserError?:string|null;elapsedMs?:number;errorCategories?:string[]}}
interface ProviderDraft {selected: 'subscription'|'api'; api: {profileId:string;name:string;baseUrl:string;protocol:string;model:string;reasoningEffort?:string;maxOutputTokens:number;dailyCallLimit:number;keyConfigured?:boolean}|null}
interface ProviderSettings {generation:number;revision:number;selected:'subscription'|'api';state:string;active:ProviderDraft;draft:ProviderDraft;keyConfigured:boolean;account?:{label:string;observedAt:number;expiresAt:number}|null;accountStatus?:'unknown'|'checking'|'ready'|'signed_out'|'unavailable';recipient?:string}
interface SettingsApi {
  getStatus(): Promise<SettingsStatus>; preflight(): Promise<SettingsStatus & {allowed: boolean; challenge?: string}>; confirm(revision: number, challenge: string): Promise<SettingsStatus>; revokeConsent(): Promise<SettingsStatus & {consentRevoked:boolean}>;
  readProviderSettings?(): Promise<ProviderSettings>; saveProviderSettings?(payload: unknown): Promise<ProviderSettings>; replaceSubscriptionAccount?(payload: unknown): Promise<{outcome:string}>;
  checkProvider?(payload: unknown): Promise<{ok:boolean;stage:string;message:string}>; trialProvider?(payload: unknown): Promise<ProviderSettings>; activateProvider?(payload: unknown): Promise<ProviderSettings>; startProvider?(payload: unknown): Promise<ProviderSettings>; cancelProviderAction?(): Promise<ProviderSettings>;
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
  message.textContent=value.reason==='unresolved_previous_call'?
    '旧估时调用正在自动检查与恢复，无需手动试探。无法确认进程身份的遗留调用通常在五分钟后释放占用；可识别且仍未结束的进程继续等待确认，未知用量会保留。':value.state==='cooldown'?
    typeof next==='number'&&Number.isSafeInteger(next)&&next>=0&&next<=8640000000000000?
      `下次可尝试：${new Date(next).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}（仅在有任务时）`:
      '等待满足恢复条件；空闲时不会发起试探。':
    value.state==='warning'?'未知用量仍保留在账本中，后续调用受预算和自动恢复限制。':'';
  known.textContent = String(value.knownTokens);
  unknown.textContent = String(value.unknown);
  recover.disabled = challenge === undefined || !value.recoveryAllowed || value.state === 'checking' || value.state === 'probing' || value.state === 'awaiting_confirmation';
}

let refreshGeneration = 0;
async function refresh(): Promise<boolean> {
  const generation = ++refreshGeneration;
  if (!api) { message.textContent = '设置接口不可用'; return false; }
  try {
    const value = await api.getStatus();
    if (generation !== refreshGeneration) return false;
    render(value); return true;
  }
  catch {
    if (generation === refreshGeneration) {state.textContent='状态未知';message.textContent = '无法读取本地设置状态';}
    return false;
  }
}

check.addEventListener('click', () => {
  void (async () => {
    if (!api) return;
    message.textContent = '正在进行本地检查…';
    try { const result = await api.preflight(); challenge = result.challenge; render(result);
      if(result.reason!=='unresolved_previous_call'&&result.state!=='cooldown'&&result.state!=='warning')message.textContent = result.allowed ? '检查完成，可以进行一次显式试探。'
        : result.state==='normal'||result.state==='recovered' ? '当前无需恢复试探；此检查不验证模型推理。'
        : `当前不能进行恢复试探（${result.state}）；请查看提供方与授权状态。`; }
    catch { challenge=undefined;recover.disabled=true;message.textContent = '无法完成恢复检查；这不代表当前估时已停用。'; }
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
const providerUsageNotice = document.querySelector<HTMLElement>('#provider-usage-notice');
const providerApiFields = document.querySelector<HTMLElement>('#provider-api-fields');
const providerSave = document.querySelector<HTMLButtonElement>('#provider-save');
const providerStart = document.querySelector<HTMLButtonElement>('#provider-start');
const providerConsent = document.querySelector<HTMLInputElement>('#provider-consent');
const providerCheck = document.querySelector<HTMLButtonElement>('#provider-check');
const providerTrial = document.querySelector<HTMLButtonElement>('#provider-trial');
const providerActivate = document.querySelector<HTMLButtonElement>('#provider-activate');
const providerCancel = document.querySelector<HTMLButtonElement>('#provider-cancel');
const login = document.querySelector<HTMLButtonElement>('#subscription-login');
const deviceLogin = document.querySelector<HTMLButtonElement>('#subscription-device-login');
const logout = document.querySelector<HTMLButtonElement>('#subscription-logout');
let providerSnapshot: ProviderSettings | undefined;
let providerBusy = false;
const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_PROVIDER_NAME = 'OpenAI API';
const DEFAULT_REASONING_EFFORT = 'medium';
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_DAILY_CALL_LIMIT = 24;
const SUBSCRIPTION_RECIPIENT = 'OpenAI / ChatGPT 订阅账户';

function providerDraftFromInputs(): ProviderDraft {
  if (providerSource?.value === 'subscription') return {selected: 'subscription', api: null};
  const effort=reasoningEffort?.value || DEFAULT_REASONING_EFFORT;
  const maxTokens=Number(maxOutputTokens?.value || DEFAULT_MAX_OUTPUT_TOKENS);
  const callLimit=Number(dailyCallLimit?.value || DEFAULT_DAILY_CALL_LIMIT);
  return {selected: 'api', api: {profileId: profileId?.value.trim() || DEFAULT_PROFILE_ID, name: providerName?.value.trim() || DEFAULT_PROVIDER_NAME, baseUrl: baseUrl?.value.trim() ?? '', protocol: protocol?.value || 'responses', model: model?.value.trim() ?? '', ...(effort ? {reasoningEffort: effort} : {}),
    maxOutputTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_OUTPUT_TOKENS, dailyCallLimit: Number.isSafeInteger(callLimit) && callLimit > 0 ? callLimit : DEFAULT_DAILY_CALL_LIMIT}};
}
function setProviderBusy(value: boolean): void {
  providerBusy = value;
  for (const control of [providerStart, providerSave, providerCheck, providerTrial, providerActivate, login, deviceLogin, logout, providerConsent]) if (control) control.disabled = value;
  if (providerCancel) providerCancel.disabled = !value;
}
function liveApiRecipient(): string {
  const endpoint=baseUrl?.value.trim() ?? '';
  const selectedModel=model?.value.trim() ?? '';
  if (!endpoint) return selectedModel ? `API 提供方 · ${selectedModel}` : 'API 提供方';
  try { const url=new URL(endpoint); return `${url.origin}${url.pathname} · ${selectedModel || '未填写模型'}`; }
  catch { return `${endpoint} · ${selectedModel || '未填写模型'}`; }
}
function renderProviderView(): void {
  const source=providerSource?.value === 'api' ? 'api' : 'subscription';
  if (providerApiFields) providerApiFields.hidden = source !== 'api';
  if (recipient) recipient.textContent = source === 'api' ? liveApiRecipient() : SUBSCRIPTION_RECIPIENT;
  if (providerUsageNotice) providerUsageNotice.textContent = source === 'api'
    ? `API 估时会向 ${recipient?.textContent ?? '所示提供方'} 发送任务摘要，调用可能产生费用。`
    : '订阅估时会消耗所示账户的订阅额度；不会复制主 Codex 凭据。';
  if (providerStart) providerStart.textContent = source === 'api' ? '保存并开始' : providerSnapshot?.account ? '开始估时' : providerSnapshot?.accountStatus==='signed_out' ? '登录并开始' : '检查账户并开始';
}
function renderProvider(value: ProviderSettings): void {
  providerSnapshot = value;
  if (providerSource) providerSource.value = value.draft.selected;
  const draft = value.draft.api;
  if (draft) {
    if (profileId) profileId.value = draft.profileId; if (providerName) providerName.value = draft.name; if (baseUrl) baseUrl.value = draft.baseUrl;
    if (model) model.value = draft.model; if (protocol) protocol.value = draft.protocol; if (reasoningEffort) reasoningEffort.value = draft.reasoningEffort ?? 'medium';
    if (maxOutputTokens) maxOutputTokens.value = String(draft.maxOutputTokens); if (dailyCallLimit) dailyCallLimit.value = String(draft.dailyCallLimit);
    if (draft.protocol !== 'responses') message.textContent = '不支持的协议；请选择 Responses。';
  }
  if (keyState) keyState.textContent = (draft?.keyConfigured ?? false) ? '已配置（密钥不会显示）' : '未配置密钥';
  if (account) account.textContent = value.account?.label ?? (value.accountStatus==='signed_out'?'未登录订阅账户':value.accountStatus==='unavailable'?'账户检查失败；不代表已退出登录':value.accountStatus==='checking'?'正在检查订阅账户…':'订阅账户尚未检查');
  if (accountTime) accountTime.textContent = value.account ? `观察时间：${new Date(value.account.observedAt).toLocaleString('zh-CN')}；有效至：${new Date(value.account.expiresAt).toLocaleString('zh-CN')}` : '—';
  if (dirty) dirty.textContent = '已保存';
  renderProviderView();
}
function providerEnvelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {generation: providerSnapshot?.generation ?? 0, revision: providerSnapshot?.revision ?? 0, ...extra};
}
function markDirty(): void {
  if (providerConsent) providerConsent.checked = false;
  if (dirty && providerSnapshot) {
    const original = providerSnapshot.draft;
    const fields = original.api ? (({keyConfigured: _metadata, ...rest}) => rest)(original.api) : null;
    dirty.textContent = JSON.stringify(providerDraftFromInputs()) === JSON.stringify({selected:original.selected, api:fields}) ? '已保存' : '有未保存更改';
  }
}
function providerInputChanged(): void { markDirty(); renderProviderView(); }
async function refreshProvider(): Promise<void> {
  if (!providerApi?.readProviderSettings) return;
  try { renderProvider(await providerApi.readProviderSettings()); } catch { message.textContent = '无法读取提供方设置'; }
}
let providerActionGeneration = 0;
let providerCancelling = false;
async function providerAction(operation: () => Promise<unknown>, success: string): Promise<void> {
  if (providerBusy) return; setProviderBusy(true);
  const generation = ++providerActionGeneration;
  try { await operation(); if (generation !== providerActionGeneration) return; await refreshProvider(); if (generation !== providerActionGeneration) return; challenge=undefined; const refreshed=await refresh(); if (generation === providerActionGeneration) message.textContent = refreshed ? success : '操作已完成，但状态刷新失败；请重新打开设置查看。'; }
  catch (error) { if (generation !== providerActionGeneration) return; const text = error instanceof Error && error.message === 'SETTINGS_INVALID_REQUEST' ? '设置请求无效' : error instanceof Error && error.message === 'PROVIDER_ACTION_CANCELLED' ? '已取消账户操作。' : error instanceof Error && error.message === 'PROVIDER_INLINE_CONSENT_REQUIRED' ? '请先同意接收方和用量说明。' : '提供方操作失败；估时保持停用。'; message.textContent = text; }
  finally { if (generation === providerActionGeneration) setProviderBusy(false); }
}
for (const control of [profileId, providerName, baseUrl, model, protocol, reasoningEffort, maxOutputTokens, dailyCallLimit]) control?.addEventListener('input', providerInputChanged);
providerSource?.addEventListener('input', providerInputChanged);
providerSource?.addEventListener('change', providerInputChanged);
apiKey?.addEventListener('input', () => { if (providerConsent) providerConsent.checked = false; });
providerStart?.addEventListener('click', () => void providerAction(async () => {
  if (!providerApi?.startProvider) return;
  if (!providerConsent?.checked) { message.textContent = '请先同意接收方和用量说明。'; throw new Error('PROVIDER_INLINE_CONSENT_REQUIRED'); }
  const selected = providerSource?.value === 'api' ? 'api' : 'subscription';
  const extra = selected === 'api' ? {draft: providerDraftFromInputs(), ...(apiKey?.value ? {secret: apiKey.value} : {})} : {};
  if (apiKey) apiKey.value = '';
  await providerApi.startProvider(providerEnvelope({selected, consent: true, ...extra}));
}, '已准备估时；尚未证明模型推理可用。'));
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
providerCancel?.addEventListener('click', () => {
  if (!providerBusy || providerCancelling) return;
  providerCancelling = true; providerActionGeneration++;
  providerCancel.disabled = true;
  void (async () => {
    try { await providerApi?.cancelProviderAction?.(); await refreshProvider(); message.textContent = '操作已取消；请检查当前提供方状态。'; }
    catch { message.textContent = '取消未完成；请等待请求清理并检查状态。'; }
    finally { providerCancelling = false; setProviderBusy(false); }
  })();
});
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
