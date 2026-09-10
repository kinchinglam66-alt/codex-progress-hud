import { describe, expect, it, vi } from "vitest";
import { createObserverAccountSettings, type ObserverAccountIdentity } from "../../src/desktop/observer-account-settings.js";
import type { ObserverAttestation } from "../../src/estimation/observer-consent.js";
import type { LoginProcessOutcome, ObserverLoginOwner } from "../../src/estimation/observer-login-owner.js";

const evidence: ObserverAttestation = {
  accountFingerprint: "a".repeat(64), routeFingerprint: "b".repeat(64), assetsFingerprint: "c".repeat(64),
  observedAt: 0, expiresAt: 300000,
};
const identity = (inspect: ObserverAccountIdentity["inspect"]): ObserverAccountIdentity => ({
  inspect,
  prepareLogin: vi.fn(async () => ({executable: process.execPath, cwd: process.cwd(), args: [], env: {}, input: ""})),
  prepareDeviceLogin: vi.fn(async () => ({executable: process.execPath, cwd: process.cwd(), args: [], env: {}, input: ""})),
  prepareLogout: vi.fn(async () => ({executable: process.execPath, cwd: process.cwd(), args: [], env: {}, input: ""})),
  disable: vi.fn(), close: vi.fn(async () => undefined),
});
const loginOwner = (overrides: Partial<ObserverLoginOwner> = {}): ObserverLoginOwner => ({
  login: vi.fn(async (): Promise<LoginProcessOutcome> => "process_exited"),
  deviceAuth: vi.fn(async (): Promise<LoginProcessOutcome> => "process_exited"),
  deviceLogin: vi.fn(async (): Promise<LoginProcessOutcome> => "process_exited"),
  logout: vi.fn(async (): Promise<LoginProcessOutcome> => "process_exited"),
  disable: vi.fn(), close: vi.fn(async () => undefined),
  ...overrides,
});

describe("observer account settings", () => {
  it("attests identity after a successful subscription login", async () => {
    const inspect = vi.fn(async () => ({accountLabel: "person@example.invalid", evidence}));
    const settings = createObserverAccountSettings({identity: identity(inspect), loginOwner: loginOwner()});
    expect(await settings.login(new AbortController().signal)).toBe("process_exited");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(settings.status()).toMatchObject({state: "ready", accountLabel: "person@example.invalid"});
  });

  it("keeps admission inactive after login failure or cancellation", async () => {
    const inspect = vi.fn(async () => ({accountLabel: "should-not-be-used", evidence}));
    const settings = createObserverAccountSettings({
      identity: identity(inspect),
      loginOwner: loginOwner({login: vi.fn(async (): Promise<LoginProcessOutcome> => "failed")}),
    });
    expect(await settings.login(new AbortController().signal)).toBe("failed");
    expect(inspect).not.toHaveBeenCalled();
    expect(settings.status().state).toBe("inactive");
  });

  it("uses the official logout action and clears the attested account immediately", async () => {
    const inspect = vi.fn(async () => ({accountLabel: "person@example.invalid", evidence}));
    const owner = loginOwner();
    const settings = createObserverAccountSettings({identity: identity(inspect), loginOwner: owner});
    await settings.login(new AbortController().signal);
    expect(await settings.logout(new AbortController().signal)).toBe("process_exited");
    expect(owner.logout).toHaveBeenCalledTimes(1);
    expect(settings.status()).toMatchObject({state: "inactive", accountLabel: null});
  });

  it("does not treat device-login exit as identity until a fresh attestation succeeds", async () => {
    const inspect = vi.fn()
      .mockRejectedValueOnce(new Error("OBSERVER_LOGIN_REQUIRED"))
      .mockResolvedValueOnce({accountLabel: "device@example.invalid", evidence});
    const owner = loginOwner();
    const settings = createObserverAccountSettings({identity: identity(inspect), loginOwner: owner});
    expect(await settings.deviceAuth(new AbortController().signal)).toBe("failed");
    expect(settings.status().state).toBe("inactive");
    expect(await settings.deviceAuth(new AbortController().signal)).toBe("process_exited");
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(settings.status()).toMatchObject({state: "ready", accountLabel: "device@example.invalid"});
  });

  it("delegates provider-owner shutdown to the real account owner", async () => {
    const owner = loginOwner();
    const identityValue = identity(vi.fn(async () => ({accountLabel: "person@example.invalid", evidence})));
    const settings = createObserverAccountSettings({identity: identityValue, loginOwner: owner});
    await settings.providerOwner().close();
    expect(owner.close).toHaveBeenCalledTimes(1);
    expect(identityValue.close).toHaveBeenCalledTimes(1);
    expect(settings.status().state).toBe("inactive");
  });

  it("does not publish a deferred inspect or login result after shutdown", async () => {
    let resolveInspect!: (value: {accountLabel: string; evidence: ObserverAttestation}) => void;
    const inspect = vi.fn(() => new Promise<{accountLabel: string; evidence: ObserverAttestation}>(resolve => { resolveInspect = resolve; }));
    const owner = loginOwner();
    let resolveLogin!: (value: LoginProcessOutcome) => void;
    owner.login = vi.fn(() => new Promise<LoginProcessOutcome>(resolve => { resolveLogin = resolve; }));
    const settings = createObserverAccountSettings({identity: identity(inspect), loginOwner: owner});
    const inspecting = settings.inspect(new AbortController().signal);
    const loggingIn = settings.login(new AbortController().signal);
    const closing = settings.close();
    resolveInspect({accountLabel: "late@example.invalid", evidence});
    await expect(inspecting).rejects.toThrow("OBSERVER_ACCOUNT_SETTINGS_CLOSED");
    resolveLogin("process_exited");
    expect(await loggingIn).toBe("cancelled");
    await closing;
    expect(settings.status().state).toBe("inactive");
  });
});
