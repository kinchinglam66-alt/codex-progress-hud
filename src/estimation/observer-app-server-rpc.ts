import type {Readable, Writable} from 'node:stream';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 32;

export type AppServerNotification = {
  method: string;
  params: Record<string, unknown>;
};

export interface ObserverAppServerRpcOptions {
  input: Writable;
  output: Readable;
  timeoutMs?: number;
  maxFrameBytes?: number;
}

export interface ObserverAppServerRpc {
  call(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  subscribe(listener: (notification: AppServerNotification) => void): () => void;
  close(reason?: string): void;
  closed(): boolean;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type OutgoingFrame = Buffer;

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSafeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function optionLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`Invalid ${name}`);
  return resolved;
}

function transportError(code: string): Error {
  return new Error(code);
}

function encodeFrame(value: unknown): Buffer {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw transportError('APP_SERVER_RPC_SERIALIZE_FAILED');
  return Buffer.from(`${encoded}\n`, 'utf8');
}

export function createObserverAppServerRpc(options: ObserverAppServerRpcOptions): ObserverAppServerRpc {
  const timeoutMs = optionLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'RPC timeout');
  const maxFrameBytes = optionLimit(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 'RPC frame size');
  const {input, output} = options;
  const pending = new Map<number, PendingRequest>();
  const subscribers = new Set<(notification: AppServerNotification) => void>();
  const outgoing: OutgoingFrame[] = [];
  const activeWriteRejectors = new Set<(reason: Error) => void>();
  const frameParts: Buffer[] = [];
  let frameBytes = 0;
  let nextId = 1;
  let writing = false;
  let isClosed = false;

  const cleanupPending = (request: PendingRequest): void => {
    clearTimeout(request.timer);
  };

  const rejectPending = (reason: Error): void => {
    for (const [id, request] of pending) {
      pending.delete(id);
      cleanupPending(request);
      request.reject(reason);
    }
  };

  const close = (reason = 'APP_SERVER_RPC_CLOSED'): void => {
    if (isClosed) return;
    isClosed = true;
    const error = transportError(reason);
    rejectPending(error);
    outgoing.length = 0;
    for (const reject of activeWriteRejectors) reject(error);
    activeWriteRejectors.clear();
    subscribers.clear();
    input.removeListener('error', onInputError);
    output.removeListener('data', onData);
    output.removeListener('end', onEnd);
    output.removeListener('error', onOutputError);
    output.removeListener('close', onOutputClose);
  };

  const writeFrame = (frame: OutgoingFrame): Promise<void> => new Promise((resolve, reject) => {
    if (isClosed) {
      reject(transportError('APP_SERVER_RPC_CLOSED'));
      return;
    }
    let callbackDone = false;
    let drainDone = true;
    let settled = false;
    let onDrain: (() => void) | undefined;

    const cleanup = (): void => {
      if (onDrain) input.removeListener('drain', onDrain);
      activeWriteRejectors.delete(onClosed);
    };
    const finish = (): void => {
      if (!callbackDone || !drainDone || settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (reason: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const onClosed = (reason: Error): void => fail(reason);
    activeWriteRejectors.add(onClosed);
    onDrain = () => {
      drainDone = true;
      finish();
    };
    try {
      const accepted = input.write(frame, (error?: Error | null) => {
        if (error) {
          fail(transportError('APP_SERVER_RPC_WRITE_FAILED'));
          close('APP_SERVER_RPC_WRITE_FAILED');
          return;
        }
        callbackDone = true;
        finish();
      });
      if (!accepted) {
        drainDone = false;
        input.once('drain', onDrain);
      }
    } catch {
      fail(transportError('APP_SERVER_RPC_WRITE_FAILED'));
      close('APP_SERVER_RPC_WRITE_FAILED');
    }
  });

  const pump = async (): Promise<void> => {
    if (writing) return;
    writing = true;
    try {
      while (!isClosed && outgoing.length > 0) {
        const frame = outgoing.shift();
        if (frame === undefined) continue;
        await writeFrame(frame);
      }
    } catch {
      close('APP_SERVER_RPC_WRITE_FAILED');
    } finally {
      writing = false;
      if (!isClosed && outgoing.length > 0) void pump();
    }
  };

  const enqueue = (frame: OutgoingFrame): void => {
    if (isClosed) return;
    outgoing.push(frame);
    void pump();
  };

  const settleResponse = (id: number, value: unknown, error?: Error): void => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    cleanupPending(request);
    if (error) request.reject(error);
    else request.resolve(value);
  };

  const sendMethodNotFound = (id: number): void => {
    try {
      enqueue(encodeFrame({jsonrpc: '2.0', id, error: {code: -32601, message: 'Method not found'}}));
    } catch {
      close('APP_SERVER_RPC_WRITE_FAILED');
    }
  };

  const processMessage = (message: unknown): void => {
    if (!isRecord(message)) {
      close('APP_SERVER_RPC_INVALID_RESPONSE');
      return;
    }

    if (!hasOwn(message, 'id')) {
      if (typeof message.method !== 'string' || !isRecord(message.params)) return;
      const notification: AppServerNotification = {method: message.method, params: message.params};
      try {
        for (const subscriber of [...subscribers]) subscriber(notification);
      } catch {
        close('APP_SERVER_RPC_SUBSCRIBER_FAILED');
      }
      return;
    }

    if (typeof message.method === 'string') {
      if (!isSafeNumber(message.id)) {
        close('APP_SERVER_RPC_INVALID_RESPONSE');
        return;
      }
      sendMethodNotFound(message.id);
      return;
    }

    if (!isSafeNumber(message.id)) {
      close('APP_SERVER_RPC_INVALID_RESPONSE');
      return;
    }
    const hasResult = hasOwn(message, 'result');
    const hasError = hasOwn(message, 'error');
    if (hasResult === hasError) {
      close('APP_SERVER_RPC_INVALID_RESPONSE');
      return;
    }
    if (hasError) {
      if (!isRecord(message.error) || !isSafeNumber(message.error.code) || typeof message.error.message !== 'string') {
        close('APP_SERVER_RPC_INVALID_RESPONSE');
        return;
      }
      settleResponse(message.id, undefined, transportError('APP_SERVER_RPC_ERROR'));
      return;
    }
    settleResponse(message.id, message.result);
  };

  const consumeFrame = (frame: Buffer): void => {
    if (frame.length > 0 && frame.at(-1) === 0x0d) frame = frame.subarray(0, frame.length - 1);
    if (frame.length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(frame.toString('utf8')) as unknown;
    } catch {
      close('APP_SERVER_RPC_MALFORMED_JSON');
      return;
    }
    processMessage(message);
  };

  const onData = (chunk: unknown): void => {
    if (isClosed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    let offset = 0;
    while (offset < bytes.length && !isClosed) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) {
        const part = bytes.subarray(offset);
        frameParts.push(part);
        frameBytes += part.length;
        if (frameBytes > maxFrameBytes) close('APP_SERVER_RPC_FRAME_TOO_LARGE');
        return;
      }
      const part = bytes.subarray(offset, newline);
      if (part.length > 0) {
        frameParts.push(part);
        frameBytes += part.length;
      }
      if (frameBytes > maxFrameBytes) {
        close('APP_SERVER_RPC_FRAME_TOO_LARGE');
        return;
      }
      consumeFrame(Buffer.concat(frameParts, frameBytes));
      frameParts.length = 0;
      frameBytes = 0;
      offset = newline + 1;
    }
  };

  const onInputError = (): void => close('APP_SERVER_RPC_WRITE_FAILED');
  const onOutputError = (): void => close('APP_SERVER_RPC_OUTPUT_FAILED');
  const onEnd = (): void => close('APP_SERVER_RPC_EOF');
  const onOutputClose = (): void => close('APP_SERVER_RPC_EOF');

  input.on('error', onInputError);
  output.on('data', onData);
  output.once('end', onEnd);
  output.once('error', onOutputError);
  output.once('close', onOutputClose);

  const api: ObserverAppServerRpc = {
    call(method, params) {
      return new Promise((resolve, reject) => {
        if (isClosed) {
          reject(transportError('APP_SERVER_RPC_CLOSED'));
          return;
        }
        if (pending.size >= MAX_PENDING_REQUESTS) {
          reject(transportError('APP_SERVER_RPC_PENDING_LIMIT'));
          return;
        }
        if (typeof method !== 'string' || method.length === 0) {
          reject(transportError('APP_SERVER_RPC_INVALID_METHOD'));
          return;
        }
        const id = nextId;
        nextId = nextId >= Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
        let frame: Buffer;
        try {
          frame = encodeFrame({jsonrpc: '2.0', id, method, params});
        } catch {
          reject(transportError('APP_SERVER_RPC_SERIALIZE_FAILED'));
          return;
        }
        const timer = setTimeout(() => close('APP_SERVER_RPC_TIMEOUT'), timeoutMs);
        timer.unref?.();
        pending.set(id, {resolve, reject, timer});
        enqueue(frame);
      });
    },
    notify(method, params) {
      if (isClosed || typeof method !== 'string' || method.length === 0) return;
      try {
        enqueue(encodeFrame({jsonrpc: '2.0', method, params}));
      } catch {
        close('APP_SERVER_RPC_SERIALIZE_FAILED');
      }
    },
    subscribe(listener) {
      if (isClosed) return () => undefined;
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    close,
    closed: () => isClosed,
  };
  return api;
}
