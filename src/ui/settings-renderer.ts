type SettingsState = 'normal' | 'warning' | 'cooldown' | 'blocked' | 'checking' | 'awaiting_confirmation' | 'probing' | 'recovered' | 'failed' | 'unconfigured' | 'unauthorized' | 'repair_environment';
interface SettingsStatus {state: SettingsState; revision: number; knownTokens: number; unknown: number; recoveryAllowed: boolean;nextEligibleAt?:number|null;cooldownUntil?:number|null;lastDiagnostic?: {stage:string;outcome:string;usagePresent:boolean;closureConfirmed:boolean;callReason?:string;processReason?:string;exitCode?:number|null;parserError?:string|null;elapsedMs?:number;errorCategories?:string[]}}
interface SettingsApi {getStatus(): Promise<SettingsStatus>; preflight(): Promise<SettingsStatus & {allowed: boolean; challenge?: string}>; confirm(revision: number, challenge: string): Promise<SettingsStatus>; revokeConsent(): Promise<SettingsStatus & {consentRevoked:boolean}>}
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
