import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawn, type ChildProcess} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, expect, it} from 'vitest';
import {openReleaseAccounting, type ReleaseAccountingOwner} from '../../src/estimation/release-accounting.js';

const DB_NAME = 'release-observer-accounting.sqlite';
const MAX_TOKEN = 1_000_000_000;
const paths: string[] = [];
const owners: ReleaseAccountingOwner[] = [];
const usage = {inputTokens: 10, outputTokens: 2, cachedInputTokens: 5};

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hud-release-crash-'));
  paths.push(path);
  return path;
}

async function open(path: string, now: () => number): Promise<ReleaseAccountingOwner> {
  const owner = await openReleaseAccounting(path, now);
  owners.push(owner);
  return owner;
}

async function childModule(path: string): Promise<string> {
  const compileRoot = await mkdtemp(join(process.cwd(), '.task4-child-'));
  paths.push(compileRoot);
  const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  await new Promise<void>((resolve, reject) => {
    const compiler = spawn(process.execPath, [tsc, '--ignoreConfig', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', '--rootDir', join(process.cwd(), 'src'), '--outDir', compileRoot,
      join(process.cwd(), 'src', 'estimation', 'release-accounting.ts'), join(process.cwd(), 'src', 'estimation', 'subscription-accounting.ts')], {cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
    let stderr = '';
    compiler.stderr.on('data', chunk => {stderr += chunk.toString();});
    compiler.once('error', reject);
    compiler.once('close', code => code === 0 ? resolve() : reject(new Error(`tsc:${code}:${stderr}`)));
  });
  return pathToFileURL(join(compileRoot, 'estimation', 'release-accounting.js')).href;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await access(path); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  throw new Error(`TEST_CHILD_NOT_READY:${path}`);
}

function childStderr(child: ChildProcess): {text: string; attach(): void} {
  let text = '';
  return {get text() { return text; }, attach() { child.stderr?.on('data', chunk => {text += chunk.toString();}); }};
}

function waitForClose(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('TEST_CHILD_CLOSE_TIMEOUT')); }, 5000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close().catch(() => undefined);
  for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});
});

it('reopens after a real owner child commits a pending reservation and is killed', async () => {
  const path = await directory();
  const moduleUrl = await childModule(path);
  const idPath = join(path, 'reservation.id');
  const readyPath = join(path, 'ready.marker');
  const code = `
    const fs = await import('node:fs');
    const {openReleaseAccounting} = await import(${JSON.stringify(moduleUrl)});
    const owner = await openReleaseAccounting(${JSON.stringify(path)}, () => 0);
    const id = await owner.forConversation('conversation-child').reserve();
    fs.writeFileSync(${JSON.stringify(idPath)}, id);
    fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {cwd: path, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
  const diagnostics = childStderr(child); diagnostics.attach();
  try { await waitForFile(readyPath); }
  catch (error) { child.kill('SIGKILL'); throw new Error(`${String(error)} ${diagnostics.text}`); }
  const id = (await readFile(idPath, 'utf8')).trim();
  child.kill('SIGKILL');
  await waitForClose(child);

  const owner = await open(path, () => 0);
  const view = owner.forConversation('conversation-child');
  expect(await view.reserve()).toBeNull();
  await view.settle(id, usage);
  expect(await view.reserve()).toMatch(/^[0-9a-f-]{36}$/);
});

it('denies a separate owner while the real child holds the database lock', async () => {
  const path = await directory();
  const moduleUrl = await childModule(path);
  const readyPath = join(path, 'contention.ready');
  const code = `
    const fs = await import('node:fs');
    const {openReleaseAccounting} = await import(${JSON.stringify(moduleUrl)});
    const owner = await openReleaseAccounting(${JSON.stringify(path)}, () => 0);
    fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {cwd: path, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
  const diagnostics = childStderr(child); diagnostics.attach();
  let unexpectedOwner: ReleaseAccountingOwner | undefined;
  try {
    await waitForFile(readyPath);
    await expect(openReleaseAccounting(path, () => 0).then(owner => {
      unexpectedOwner = owner;
      return owner;
    })).rejects.toThrow();
  } finally {
    try { await unexpectedOwner?.close(); }
    finally {
      const closed = waitForClose(child);
      child.kill('SIGKILL');
      await closed;
    }
  }
  const recovered = await open(path, () => 0);
  expect(recovered.snapshot().starts).toBe(0);
});

it('rolls back a killed uncommitted transaction against the actual initialized owner schema', async () => {
  const path = await directory();
  const moduleUrl = await childModule(path);
  const markerPath = join(path, 'before-death.marker');
  const dbPath = join(path, DB_NAME);
  const code = `
    const fs = await import('node:fs');
    const {DatabaseSync} = await import('node:sqlite');
    const {openReleaseAccounting} = await import(${JSON.stringify(moduleUrl)});
    const owner = await openReleaseAccounting(${JSON.stringify(path)}, () => 0);
    await owner.close();
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO admissions (id, ordinal, conversation, admitted_at, state, input_tokens, output_tokens, cached_input_tokens) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)")
      .run('00000000-0000-4000-8000-000000000002', 1, 'conversation-rollback', 0, ${MAX_TOKEN}, ${MAX_TOKEN}, ${MAX_TOKEN});
    fs.writeFileSync(${JSON.stringify(markerPath)}, 'before-death');
    process.exit(0);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {cwd: path, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
  const diagnostics = childStderr(child); diagnostics.attach();
  try { await waitForFile(markerPath); }
  catch (error) { child.kill('SIGKILL'); throw new Error(`${String(error)} ${diagnostics.text}`); }
  await waitForClose(child);
  const owner = await open(path, () => 0);
  expect(await owner.forConversation('conversation-rollback').reserve()).toMatch(/^[0-9a-f-]{36}$/);
});
