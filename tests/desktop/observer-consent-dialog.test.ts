import {expect, it} from 'vitest';
import {createObserverConsentGate} from '../../src/estimation/observer-consent.js';
import {requestObserverConsent} from '../../src/desktop/observer-consent-dialog.js';

const proof = {accountFingerprint: 'a'.repeat(64), routeFingerprint: 'b'.repeat(64),
  assetsFingerprint: 'c'.repeat(64), observedAt: 0, expiresAt: 1000};
const gate = () => createObserverConsentGate({now: () => 0, onInvalidate() {}});

it('never opens native consent without current verified host metadata', async () => {
  const value = gate(); let opened = false;
  expect(await requestObserverConsent(value, {async showMessageBox() {opened = true; return {response: 0};}}, 'account')).toBe(false);
  expect(opened).toBe(false); expect(value.authorized()).toBe(false);
});

it('requires an explicit affirmative response, never default selection', async () => {
  const value = gate(); value.update(proof);
  expect(await requestObserverConsent(value, {async showMessageBox(options) {
    expect(options.defaultId).toBe(options.cancelId);
    return {response: options.defaultId};
  }}, 'account')).toBe(false);
  expect(value.authorized()).toBe(false);
  expect(await requestObserverConsent(value, {async showMessageBox() {return {response: 0};}}, 'account')).toBe(true);
  expect(value.authorized()).toBe(true);
});

it('rejects approval from an open dialog after account binding changed', async () => {
  const value = gate(); value.update(proof);
  expect(await requestObserverConsent(value, {async showMessageBox() {
    value.update({...proof, accountFingerprint: 'd'.repeat(64)});
    return {response: 0};
  }}, 'account')).toBe(false);
  expect(value.authorized()).toBe(false);
});

it('keeps approval absent on malformed labels and native failures', async () => {
  const value = gate(); value.update(proof);
  let opened = false;
  expect(await requestObserverConsent(value, {async showMessageBox() {opened = true; return {response: 0};}}, 'fake\naccount')).toBe(false);
  expect(opened).toBe(false);
  expect(await requestObserverConsent(value, {async showMessageBox() {throw Error('private diagnostic');}}, 'account')).toBe(false);
  expect(value.authorized()).toBe(false);
});
