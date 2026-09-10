import type { Invocation } from '../estimation/owned-process.js';
import {
  createObserverLoginOwner,
  type LoginProcessOutcome,
  type ObserverDeviceAuthEvent,
  type ObserverLoginOwner,
} from '../estimation/observer-login-owner.js';
import type { ObserverAttestation } from '../estimation/observer-consent.js';

export interface ObserverAccountSnapshot {
  accountLabel: string;
  evidence: ObserverAttestation;
}

export interface ObserverAccountIdentity {
  inspect(signal: AbortSignal): Promise<ObserverAccountSnapshot>;
  prepareLogin(signal: AbortSignal): Promise<Invocation>;
  prepareDeviceLogin(signal: AbortSignal): Promise<Invocation>;
  prepareLogout(signal: AbortSignal): Promise<Invocation>;
  disable(): void;
  close(): Promise<void>;
}

export type ObserverAccountSettingsState = 'inactive' | 'switching' | 'ready' | 'failed';
export interface ObserverAccountSettingsStatus {
  state: ObserverAccountSettingsState;
  accountLabel: string | null;
  fingerprint: string | null;
}

export interface ObserverAccountSettings {
  inspect(signal: AbortSignal): Promise<ObserverAccountSnapshot>;
  login(signal: AbortSignal): Promise<LoginProcessOutcome>;
  deviceAuth(signal: AbortSignal, onDeviceAuth?: (event: ObserverDeviceAuthEvent) => void): Promise<LoginProcessOutcome>;
  deviceLogin(signal: AbortSignal, onDeviceAuth?: (event: ObserverDeviceAuthEvent) => void): Promise<LoginProcessOutcome>;
  logout(signal: AbortSignal): Promise<LoginProcessOutcome>;
  status(): ObserverAccountSettingsStatus;
  providerOwner(): {
    close(): Promise<void>;
    inspect(signal: AbortSignal): Promise<{label: string; fingerprint: string}>;
  };
  close(): Promise<void>;
}

interface Options {
  identity: ObserverAccountIdentity;
  loginOwner?: ObserverLoginOwner;
  onDeviceAuth?: (event: ObserverDeviceAuthEvent) => void;
}

const closedError = (): Error => new Error('OBSERVER_ACCOUNT_SETTINGS_CLOSED');
const staleError = (): Error => new Error('OBSERVER_ACCOUNT_SETTINGS_STALE');

/**
 * Subscription account control. A successful CLI exit is followed by an
 * isolated account attestation; without that attestation the account remains
 * inactive and no selection may dispatch against it.
 */
export function createObserverAccountSettings({identity, loginOwner, onDeviceAuth}: Options): ObserverAccountSettings {
  const owner = loginOwner ?? createObserverLoginOwner((signal, action = 'login') => {
    if (action === 'logout') return identity.prepareLogout(signal);
    if (action === 'device-auth') return identity.prepareDeviceLogin(signal);
    return identity.prepareLogin(signal);
  }, onDeviceAuth === undefined ? {} : {onDeviceAuth});
  let state: ObserverAccountSettingsState = 'inactive';
  let account: ObserverAccountSnapshot | null = null;
  let closing: Promise<void> | undefined;
  let closed = false;
  let generation = 0;

  const status = (): ObserverAccountSettingsStatus => ({
    state,
    accountLabel: account?.accountLabel ?? null,
    fingerprint: account?.evidence.accountFingerprint ?? null,
  });
  const deactivate = (next: ObserverAccountSettingsState = 'inactive'): void => {
    account = null;
    state = next;
  };

  async function readIdentity(signal: AbortSignal, expectedGeneration: number): Promise<ObserverAccountSnapshot> {
    try {
      const snapshot = await identity.inspect(signal);
      if (closed) throw closedError();
      if (generation !== expectedGeneration) throw staleError();
      account = snapshot;
      state = 'ready';
      return snapshot;
    } catch (error) {
      deactivate('inactive');
      if (error instanceof Error && ['OBSERVER_LOGIN_REQUIRED', 'OBSERVER_ACCOUNT_SETTINGS_CLOSED', 'OBSERVER_ACCOUNT_SETTINGS_STALE'].includes(error.message)) throw error;
      throw new Error('OBSERVER_IDENTITY_UNAVAILABLE');
    }
  }

  async function inspect(signal: AbortSignal): Promise<ObserverAccountSnapshot> {
    if (closed) throw closedError();
    const expectedGeneration = ++generation;
    return readIdentity(signal, expectedGeneration);
  }

  async function authenticated(action: 'login' | 'device-auth', signal: AbortSignal, callback?: (event: ObserverDeviceAuthEvent) => void): Promise<LoginProcessOutcome> {
    if (closed) return 'cancelled';
    const expectedGeneration = ++generation;
    deactivate('switching');
    let result: LoginProcessOutcome;
    try { result = action === 'login' ? await owner.login(signal) : await owner.deviceAuth(signal, callback); }
    catch { result = signal.aborted ? 'cancelled' : 'failed'; }
    if (closed || generation !== expectedGeneration) {
      deactivate('inactive');
      return 'cancelled';
    }
    if (result !== 'process_exited') {
      deactivate('inactive');
      return result;
    }
    try {
      await readIdentity(signal, expectedGeneration);
      return result;
    } catch {
      deactivate('inactive');
      return closed ? 'cancelled' : 'failed';
    }
  }

  return {
    inspect,
    login: signal => authenticated('login', signal),
    deviceAuth: (signal, callback) => authenticated('device-auth', signal, callback),
    deviceLogin: (signal, callback) => authenticated('device-auth', signal, callback),
    async logout(signal: AbortSignal): Promise<LoginProcessOutcome> {
      if (closed) return 'cancelled';
      const expectedGeneration = ++generation;
      deactivate('switching');
      let result: LoginProcessOutcome;
      try { result = await owner.logout(signal); }
      catch { result = signal.aborted ? 'cancelled' : 'failed'; }
      if (closed || generation !== expectedGeneration) return 'cancelled';
      deactivate('inactive');
      return result;
    },
    status,
    providerOwner() {
      return {
        close: async () => { await shutdown(); },
        async inspect(signal: AbortSignal) {
          const snapshot = await inspect(signal);
          return {label: snapshot.accountLabel, fingerprint: snapshot.evidence.accountFingerprint};
        },
      };
    },
    close: shutdown,
  };

  async function shutdown(): Promise<void> {
      if (closing) return closing;
      closed = true;
      generation += 1;
      deactivate('inactive');
      identity.disable();
      owner.disable();
      closing = (async () => {
        await Promise.all([owner.close(), identity.close()]);
      })();
      return closing;
  }
}
