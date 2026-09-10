import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {expect, it} from 'vitest';

it('loads the packaged sandboxed CommonJS settings preload and completes status IPC', async () => {
  const electron = resolve('node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const {stdout} = await promisify(execFile)(electron, ['--no-sandbox', '--disable-gpu', '--in-process-gpu', resolve('scripts/smoke-settings-preload.cjs')], {
    cwd: process.cwd(), windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024
  });
  const result = JSON.parse(stdout.trim()) as {preload: string; preloadError: boolean; bridgePresent: boolean; status: {knownTokens: number}};
  expect(result).toMatchObject({preload: 'settings-preload.cjs', preloadError: false, bridgePresent: true, status: {knownTokens: 12}});
});
