import {expect, it} from 'vitest';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createProgressServer} from '../../src/server/http-server.js';

it('serves the complete built browser module graph over authenticated HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hud-module-graph-'));
  const tokenPath = join(directory, 'auth.token');
  const server = createProgressServer({port: 0, tokenPath, uiDirectory: resolve('dist/ui')});
  try {
    await server.listen();
    const token = (await readFile(tokenPath, 'utf8')).trim();
    const pending = ['/renderer.js'], seen = new Set<string>();
    while (pending.length) {
      const path = pending.pop()!; if (seen.has(path)) continue; seen.add(path);
      const response = await fetch(server.address().url + path, {headers: {authorization: `Bearer ${token}`}});
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain('javascript');
      const source = await response.text();
      for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
        const dependency = new URL(match[1]!, server.address().url + path);
        expect(dependency.origin).toBe(new URL(server.address().url).origin);
        pending.push(dependency.pathname);
      }
    }
    expect(seen.has('/display-clock.js')).toBe(true);
    expect(seen.has('/countdown.js')).toBe(true);
  } finally {await server.close(); await rm(directory, {recursive: true, force: true});}
});
