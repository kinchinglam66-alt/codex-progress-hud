import {expect,it} from 'vitest';
import {workerAcquisitionReason} from '../../src/core/observer-diagnostics.js';

it.each([
  ['OBSERVER_ACCOUNT_REFRESH_FAILED','account_refresh_failed'],
  ['OBSERVER_WORKER_CLOSING','worker_closing'],
  ['PROVIDER_WORKER_CLOSING','worker_closing'],
  ['OBSERVER_WORKER_CLEANUP_PENDING','worker_cleanup_pending'],
  ['PROVIDER_UNAVAILABLE','provider_unavailable'],
  ['OBSERVER_NOT_READY','runtime_not_ready'],
  ['private-token-and-path','worker_unavailable'],
])('projects %s to a fixed diagnostic', (code,reason)=>{
  expect(workerAcquisitionReason(new Error(code))).toBe(reason);
});

it('does not expose arbitrary thrown values',()=>{
  expect(workerAcquisitionReason({message:'private'})).toBe('worker_unavailable');
});
