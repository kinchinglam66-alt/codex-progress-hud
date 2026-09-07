import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {openReleaseAccounting} from '../../src/estimation/release-accounting.js';

const paths: string[] = [];
const originalNodeDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')!;

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hud-release-runtime-'));
  paths.push(path);
  return path;
}

async function withNodeVersion(version: string, operation: () => Promise<void>): Promise<void> {
  Object.defineProperty(process.versions, 'node', {value: version, configurable: true});
  try { await operation(); }
  finally { Object.defineProperty(process.versions, 'node', originalNodeDescriptor); }
}

afterEach(async () => {
  Object.defineProperty(process.versions, 'node', originalNodeDescriptor);
  for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});
});

it('rejects Node 22.12 before SQLite import or state creation', async () => {
  const path = await directory();
  await withNodeVersion('22.12.0', async () => {
    await expect((async () => {
      const owner = await openReleaseAccounting(path, () => 0);
      await owner.close();
      throw new Error('RUNTIME_CHECK_NOT_ENFORCED');
    })()).rejects.toThrow('RELEASE_RUNTIME_UNSUPPORTED');
  });
  await expect(stat(join(path, 'release-observer-accounting.sqlite'))).rejects.toThrow();
});

it('accepts Node 22.13.0 at the exact floor', async () => {
  const path = await directory();
  await withNodeVersion('22.13.0', async () => {
    const owner = await openReleaseAccounting(path, () => 0);
    await owner.close();
  });
});

it('accepts a later major runtime', async () => {
  const path = await directory();
  await withNodeVersion('23.0.0', async () => {
    const owner = await openReleaseAccounting(path, () => 0);
    await owner.close();
  });
});
