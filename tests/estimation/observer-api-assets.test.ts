import {copyFile, mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {loadObserverApiAssets} from '../../src/estimation/observer-api-assets.js';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hud-api-assets-'));
  roots.push(root);
  await mkdir(join(root, 'observer-assets'));
  for (const name of ['observer.schema.json', 'observer-instructions.md']) {
    await copyFile(resolve('src/estimation/assets', name), join(root, 'observer-assets', name));
  }
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

it('loads the same pinned observer assets without a subscription runtime or credentials', async () => {
  const value = await loadObserverApiAssets(await fixture());
  expect(value.instructions.length).toBeGreaterThan(100);
  expect(value.schema).toHaveProperty('type', 'object');
  expect(Object.isFrozen(value)).toBe(true);
});

it('rejects modified or oversized resources with a fixed diagnostic', async () => {
  const root = await fixture();
  await writeFile(join(root, 'observer-assets', 'observer-instructions.md'), 'changed');
  await expect(loadObserverApiAssets(root)).rejects.toThrow('OBSERVER_API_ASSETS_UNAVAILABLE');
  await writeFile(join(root, 'observer-assets', 'observer-instructions.md'), 'x'.repeat(16385));
  await expect(loadObserverApiAssets(root)).rejects.toThrow('OBSERVER_API_ASSETS_UNAVAILABLE');
});

it('rejects missing, relative, control-character and archive paths', async () => {
  for (const root of ['relative', resolve('missing-resources'), resolve('bad') + '\n', resolve('app.asar/assets')]) {
    await expect(loadObserverApiAssets(root)).rejects.toThrow('OBSERVER_API_ASSETS_UNAVAILABLE');
  }
});
