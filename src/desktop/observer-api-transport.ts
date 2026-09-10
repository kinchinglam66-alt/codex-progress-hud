import {fetch as undiciFetch, ProxyAgent, type Dispatcher} from 'undici';

export type ApiTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface ObserverApiTransportOptions {
  /** An injected dispatcher is caller-owned and is never closed here. */
  dispatcher?: Dispatcher;
  /** Trusted explicit proxy; ambient proxy variables are not read. */
  proxyUrl?: string;
}

export type ObserverApiTransport = ApiTransport & {close(): Promise<void>};

/** Create a local Undici transport. The dispatcher is attached per request;
 * this function never changes Undici's process-wide dispatcher. */
export function createObserverApiTransport(options: ObserverApiTransportOptions = {}): ObserverApiTransport {
  if (options.dispatcher && options.proxyUrl) throw new Error('OBSERVER_API_TRANSPORT_DISPATCHER_CONFLICT');
  const ownedDispatcher = options.proxyUrl === undefined ? undefined : new ProxyAgent({uri: options.proxyUrl, proxyTunnel: false});
  const dispatcher = options.dispatcher ?? ownedDispatcher;
  let closed = false;
  let closing: Promise<void> | undefined;
  const transport = (async (url: string, init: RequestInit): Promise<Response> => {
    if (closed) throw new Error('OBSERVER_API_TRANSPORT_CLOSED');
    return undiciFetch(url, {
      ...init,
      redirect: 'error',
      ...(dispatcher === undefined ? {} : {dispatcher}),
    } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Response;
  }) as ObserverApiTransport;
  transport.close = () => {
    if (closing) return closing;
    closed = true;
    closing = ownedDispatcher ? ownedDispatcher.close() : Promise.resolve();
    return closing;
  };
  return transport;
}
