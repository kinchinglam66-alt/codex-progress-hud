export interface ChatgptAuthRefreshParams {
  reason: 'unauthorized';
  previousAccountId?: string | null;
}
export interface ChatgptAuthRefreshResult {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string | null;
}
export type ChatgptAuthRefreshHandler = (
  params: ChatgptAuthRefreshParams, signal: AbortSignal,
) => Promise<ChatgptAuthRefreshResult>;

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only authentication refresh is supported; tool/approval requests stay denied.
 * Credentials go directly to the private transport, never to error/diagnostic hooks.
 * The handler must additionally bind null/omitted previousAccountId to its session.
 */
export function createAuthRefreshRpc(options: {
  handler?: ChatgptAuthRefreshHandler;
  send(frame: unknown): void;
  close(reason: string): void;
}) {
  let closed = false;
  let active: {controller: AbortController; timer: ReturnType<typeof setTimeout>} | undefined;
  const close = () => {
    closed = true;
    if (active) {clearTimeout(active.timer); active.controller.abort(); active = undefined;}
  };
  const replyError = (id: number | string, code: number, message: string) =>
    options.send({jsonrpc: '2.0', id, error: {code, message}});
  return {close, handle(message: Record<string, unknown>): boolean {
    if (closed || !options.handler || message.method !== 'account/chatgptAuthTokens/refresh') return false;
    const id = message.id;
    if (!(typeof id === 'number' && Number.isSafeInteger(id)) && !text(id, 256)) {
      options.close('APP_SERVER_RPC_INVALID_RESPONSE'); return true;
    }
    const params = message.params;
    if (!object(params) || params.reason !== 'unauthorized' ||
        (params.previousAccountId !== undefined && params.previousAccountId !== null && !text(params.previousAccountId, 256))) {
      replyError(id, -32602, 'Invalid refresh parameters'); return true;
    }
    if (active) {options.close('APP_SERVER_RPC_AUTH_REFRESH_OVERLAP'); return true;}
    const controller = new AbortController();
    const timer = setTimeout(() => options.close('APP_SERVER_RPC_AUTH_REFRESH_TIMEOUT'), 9_000);
    timer.unref?.();
    active = {controller, timer};
    const request: ChatgptAuthRefreshParams = {reason: 'unauthorized',
      ...(params.previousAccountId === undefined ? {} : {previousAccountId: params.previousAccountId as string | null})};
    void Promise.resolve().then(() => {
      if (closed || controller.signal.aborted) return undefined;
      return options.handler!(request, controller.signal);
    }).then(result => {
      if (closed || controller.signal.aborted) return;
      if (!object(result) || !text(result.accessToken, 65536) || !text(result.chatgptAccountId, 256) ||
          (request.previousAccountId != null && request.previousAccountId !== result.chatgptAccountId) ||
          (result.chatgptPlanType !== undefined && result.chatgptPlanType !== null && !text(result.chatgptPlanType, 64))) {
        replyError(id, -32000, 'Authentication refresh unavailable'); return;
      }
      options.send({jsonrpc: '2.0', id, result: {accessToken: result.accessToken,
        chatgptAccountId: result.chatgptAccountId,
        ...(result.chatgptPlanType === undefined ? {} : {chatgptPlanType: result.chatgptPlanType})}});
    }).catch(() => {
      if (!closed && !controller.signal.aborted) replyError(id, -32000, 'Authentication refresh unavailable');
    }).finally(() => {
      clearTimeout(timer);
      if (active?.controller === controller) active = undefined;
    });
    return true;
  }};
}
