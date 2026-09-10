import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

describe('synchronous desktop bootstrap', () => {
  it.each([{args: []}, {args: ['--hud']}, {args: ['--hud', '--manager-generation=7']}])(
    'sets software rendering before loading async entry for $args', async ({args}) => {
      const argv = ['hud.exe', ...args];
      const events: string[] = [];
      const { start } = require('../../src/bootstrap.cjs');
      await start({ argv, electronRuntime: '44.1.0',
        loadElectron: () => ({ app: { disableHardwareAcceleration: () => events.push('software') } }),
        loadMain: async () => { events.push('main'); }
      });
      expect(events).toEqual(['software', 'main']);
    }
  );

  it.each(['--mcp-stdio', '--hook-event=Stop', '--automatic-login'])(
    'does not initialize Electron for %s', async flag => {
      const { start } = require('../../src/bootstrap.cjs');
      const loadElectron = vi.fn(() => { throw Error('unexpected Electron initialization'); });
      const loadMain = vi.fn(async () => undefined);
      await start({ argv: ['hud.exe', flag], electronRuntime: '44.1.0', loadElectron, loadMain });
      expect(loadElectron).not.toHaveBeenCalled();
      expect(loadMain).toHaveBeenCalledOnce();
    }
  );

  it('keeps Node entry execution free of Electron APIs', async () => {
    const { start } = require('../../src/bootstrap.cjs');
    const loadElectron = vi.fn(() => { throw Error('unexpected Electron initialization'); });
    await start({ argv: ['node', 'main.js'], electronRuntime: undefined, loadElectron, loadMain: async () => undefined });
    expect(loadElectron).not.toHaveBeenCalled();
  });
});
