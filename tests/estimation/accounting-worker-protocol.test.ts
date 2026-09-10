import {describe, expect, it} from 'vitest';
import {parseRequest, parseWorkerMessage} from '../../src/estimation/accounting-worker-protocol.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';

describe('accounting recovery protocol', () => {
  it('accepts a strict recovery confirmation request', () => {
    expect(parseRequest({
      kind: 'request', version: 1, requestId, operation: 'recovery_confirm',
      clock: 4, revision: 3, binding: 'account:route:assets',
    })).toMatchObject({operation: 'recovery_confirm', revision: 3});
  });

  it('rejects forged, malformed, and unknown recovery commands', () => {
    expect(parseRequest({
      kind: 'request', version: 1, requestId, operation: 'recovery_confirm',
      clock: 4, revision: 3, binding: 'account:route:assets', isAdmin: true,
    })).toBeUndefined();
    expect(parseRequest({
      kind: 'request', version: 1, requestId, operation: 'recovery_finish',
      clock: 4, attemptId, success: true, closureConfirmed: 'yes',
    })).toBeUndefined();
    expect(parseRequest({
      kind: 'request', version: 1, requestId, operation: 'recovery_force_success',
      clock: 4, attemptId,
    })).toBeUndefined();
  });

  it('rejects worker responses that omit the recovery snapshot', () => {
    expect(parseWorkerMessage({
      kind: 'ready', version: 1,
      snapshot: {starts: 0, activeStarts: 0, inFlight: 0, unresolved: 0, knownTokens: 0, unknown: 0, poisoned: false},
    })).toBeUndefined();
  });
});
