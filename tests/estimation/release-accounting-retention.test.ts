import {access, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {openReleaseAccounting, type ReleaseAccountingOwner} from '../../src/estimation/release-accounting.js';

const HOUR = 3_600_000;
const DB_NAME = 'release-observer-accounting.sqlite';
const usage = {inputTokens: 10, outputTokens: 2, cachedInputTokens: 5};
const paths: string[] = [];
const owners: ReleaseAccountingOwner[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hud-release-retention-'));
  paths.push(path);
  return path;
}

async function open(path: string, now: () => number): Promise<ReleaseAccountingOwner> {
  const owner = await openReleaseAccounting(path, now);
  owners.push(owner);
  return owner;
}

async function dbRows(path: string): Promise<{rows: number; starts: number; pageCount: number; maxPageCount: number}> {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(join(path, DB_NAME), {readOnly: true});
  try {
    const rows = Number((db.prepare('SELECT COUNT(*) AS count FROM admissions').get() as {count: number}).count);
    const starts = Number((db.prepare('SELECT cumulative_starts AS value FROM metadata WHERE id = 1').get() as {value: number}).value);
    const pageCount = Number((db.prepare('PRAGMA page_count').get() as {page_count: number}).page_count);
    const maxPageCount = Number((db.prepare('PRAGMA max_page_count').get() as {max_page_count: number}).max_page_count);
    return {rows, starts, pageCount, maxPageCount};
  } finally { db.close(); }
}

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close().catch(() => undefined);
  for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});
});

it('reopens through repeated retention cycles while keeping rollback journals bounded', async () => {
  let now = 0;
  const path = await directory();
  for (let cycle = 0; cycle < 5; cycle++) {
    const owner = await open(path, () => now);
    expect(owner.snapshot()).toMatchObject({starts: cycle, knownTokens: cycle * 12, unresolved: 0});
    const view = owner.forConversation(`cycle-${cycle}`);
    const id = await view.reserve();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await view.settle(id!, usage);
    expect(owner.snapshot()).toMatchObject({starts: cycle + 1, knownTokens: (cycle + 1) * 12, unresolved: 0});
    expect(await fileSize(join(path, `${DB_NAME}-journal`))).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(await fileSize(join(path, `${DB_NAME}-wal`))).toBe(0);
    await owner.close();
    owners.pop();
    expect((await dbRows(path)).rows).toBe(1);
    expect(await fileSize(join(path, `${DB_NAME}-journal`))).toBeLessThanOrEqual(8 * 1024 * 1024);
    now += HOUR;
  }
  const state = await dbRows(path);
  expect(state.starts).toBe(5);
  expect(state.rows).toBe(1);
  expect(state.pageCount).toBeLessThanOrEqual(2_048);
}, 30_000);

it('uses the bounded SQLite file and keeps cumulative totals while pruning settled rows', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const views = ['conversation-a', 'conversation-b', 'conversation-c', 'conversation-d'].map(key => owner.forConversation(key));
  for (let hour = 0; hour < 100; hour++) {
    now = hour * HOUR;
    for (const view of views) {
      for (let call = 0; call < 12; call++) {
        const id = await view.reserve();
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        await view.settle(id!, usage);
      }
    }
  }
  await owner.close();
  const dbPath = join(path, DB_NAME);
  expect((await stat(dbPath)).size).toBeLessThanOrEqual(8 * 1024 * 1024);
  const state = await dbRows(path);
  expect(state.starts).toBe(4_800);
  expect(state.rows).toBeLessThanOrEqual(4_096);
  expect(state.pageCount).toBeLessThanOrEqual(2_048);
  await expect(stat(join(path, 'release-observer-accounting.jsonl'))).rejects.toThrow();

  now = 100 * HOUR - 1;
  const reopened = await open(path, () => now);
  expect(await reopened.forConversation('conversation-a').reserve()).toBeNull();
  await reopened.close();
  owners.pop();
  now = 100 * HOUR;
  const afterWindow = await open(path, () => now);
  const afterWindowId = await afterWindow.forConversation('conversation-a').reserve();
  expect(afterWindowId).toMatch(/^[0-9a-f-]{36}$/);
  await afterWindow.forConversation('conversation-a').settle(afterWindowId!, usage);
}, 180_000);

it('refuses a full active-history capacity while preserving pending settlement', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const views = Array.from({length: 512}, (_, index) => owner.forConversation(`conversation-${index}`));
  for (let index = 0; index < views.length; index++) {
    const view = views[index]!;
    const calls = index === views.length - 1 ? 6 : 8;
    for (let call = 0; call < calls; call++) {
      const id = await view.reserve();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      await view.settle(id!, usage);
    }
  }
  expect(owner.snapshot()).toEqual(expect.objectContaining({starts: 4_094}));
  const pendingA = owner.forConversation('pending-a');
  const pendingB = owner.forConversation('pending-b');
  const pendingAId = await pendingA.reserve();
  const pendingBId = await pendingB.reserve();
  expect(pendingAId).toMatch(/^[0-9a-f-]{36}$/);
  expect(pendingBId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await owner.forConversation('pending-c').reserve()).toBeNull();
  await pendingA.settle(pendingAId!, usage);
  expect(await owner.forConversation('pending-c').reserve()).toBeNull();
  await pendingB.settle(pendingBId!, usage);
  now = HOUR;
  expect(await owner.forConversation('new-conversation').reserve()).toMatch(/^[0-9a-f-]{36}$/);
}, 180_000);

it('refuses legacy JSONL or lock state without creating a fresh SQLite database', async () => {
  const path = await directory();
  await writeFile(join(path, 'release-observer-accounting.jsonl'), '{"legacy":true}\n');
  await expect(openReleaseAccounting(path, () => 0)).rejects.toThrow('RELEASE_LEGACY_STATE');
  await expect(stat(join(path, DB_NAME))).rejects.toThrow();

  const secondPath = await directory();
  await writeFile(join(secondPath, 'release-observer-accounting.lock'), 'legacy-lock');
  await expect(openReleaseAccounting(secondPath, () => 0)).rejects.toThrow('RELEASE_LEGACY_STATE');
  await expect(stat(join(secondPath, DB_NAME))).rejects.toThrow();
});

it('refuses empty or foreign SQLite files without initializing them', async () => {
  const emptyPath = await directory();
  const emptyDb = join(emptyPath, DB_NAME);
  await writeFile(emptyDb, '');
  await expect(openReleaseAccounting(emptyPath, () => 0)).rejects.toThrow();
  expect((await stat(emptyDb)).size).toBe(0);

  const foreignPath = await directory();
  const foreignDb = join(foreignPath, DB_NAME);
  await writeFile(foreignDb, 'not a sqlite database');
  await expect(openReleaseAccounting(foreignPath, () => 0)).rejects.toThrow();
  expect(await access(foreignDb)).toBeUndefined();
});
