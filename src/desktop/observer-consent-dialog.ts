import type {createObserverConsentGate} from '../estimation/observer-consent.js';
export interface ObserverConsentDialog {
  showMessageBox(options: {
    type: 'question'; title: string; message: string; detail: string;
    buttons: string[]; defaultId: number; cancelId: number; noLink: boolean;
  }): Promise<{response: number}>;
}

/** Called only by trusted first-use desktop setup, not a second daily toggle.
 * The caller supplies an account label from the same verified snapshot as gate
 * evidence. Never call with a label or proof originating in task/model text. */
export async function requestObserverConsent(gate: ReturnType<typeof createObserverConsentGate>, dialog: ObserverConsentDialog, accountLabel: string,accountSource:'main'|'independent'='independent'): Promise<boolean> {
  if (typeof accountLabel !== 'string' || !accountLabel.trim() || accountLabel.length > 256 || /[\p{Cc}\p{Cf}]/u.test(accountLabel)) return false;
  const offer = gate.offer();
  if (!offer) return false;
  try {
    const result = await dialog.showMessageBox({
      type: 'question', title: 'Codex Progress HUD：首次估时授权',
      message: '是否允许独立模型分析任务状态和剩余时间？',
      detail: [
        `当前核验账户：${accountLabel.trim()}`,
        accountSource==='main'?'插件自动跟随主 Codex 账户；切换后使用新账户额度继续估时。只读主账户访问令牌向 OpenAI 认证，令牌仅用于隔离进程内存；不复制刷新令牌、不改写主登录。无需再次登录插件。':'插件使用独立登录目录，首次需要单独登录 ChatGPT；可以登录与主 Codex 相同的账户。不会自动复制主 Codex 的登录令牌。独立登录凭据保存在本机，应按敏感信息保护。',
        '使用你自己的 ChatGPT 订阅，估时模型由本地订阅模型配置指定，推理强度 medium。额外请求会消耗订阅额度，取消已开始的请求也可能产生用量。',
        '会将完整可读对话及工具上下文发送给 OpenAI，任务文本不脱敏；请确认这些内容可以发送。',
        '不经开发者服务器转发，不自动切换付费 API。估时和完成状态是模型判断，不保证准确或工作质量。',
        accountSource==='main'?'本授权包含跟随主账户切换。日常启用、禁用使用 Codex 插件页总开关；禁用或撤销授权会停止后续估时并取消进行中的估时。':'这是首次数据与用量授权。授权会记住在本机，账户、收件方、数据范围或计费方式变化时会再次询问。日常启用、禁用使用 Codex 插件页总开关；禁用会停止后续估时并取消进行中的估时。',
      ].join('\n\n'),
      buttons: ['同意', '暂不同意'], defaultId: 1, cancelId: 1, noLink: true,
    });
    return result.response === 0 && gate.accept(offer);
  } catch {return false;}
}
