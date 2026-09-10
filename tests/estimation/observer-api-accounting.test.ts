import { DatabaseSync } from 'node:sqlite';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApiAccounting,
  type ApiAccountingRow,
  type ApiLimits,
  type ApiProviderBinding,
  type ApiUsage,
} from '../../src/estimation/observer-api-accounting.js';

const directories: string[] = [];
const execFileAsync = promisify(execFile);
const binding: ApiProviderBinding = {kind: 'api', profileId: 'profile-a', generation: 7};
const limits: ApiLimits = {
  dailyCallLimit: 1,
  dailyTokenCap: 10,
  maxInputTokens: 4,
  maxOutputTokens: 2,
};
const usage: ApiUsage = {kind: 'api-tokens', inputTokens: 3, outputTokens: 1, cachedInputTokens: 0};

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'observer-api-accounting-'));
  directories.push(directory);
  return join(directory, 'accounting.sqlite');
}

function readFixtureRows(path: string): ApiAccountingRow[] {
  const database = new DatabaseSync(path);
  try {
    return (database.prepare('SELECT * FROM api_reservations ORDER BY created_at, id').all() as Array<Record<string, unknown>>).map(row => ({
      ...row,
      usageState: row.usage_state,
    })) as unknown as ApiAccountingRow[];
  } finally {
    database.close();
  }
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
});

describe('durable API accounting', () => {
  it('admits only one concurrent reservation at the daily call cap', async () => {
    const path = await databasePath();
    const now = Date.parse('2026-09-10T23:59:00.000Z');
    const accounting = createApiAccounting(path, () => now);
    try {
      const results = await Promise.all([
        accounting.reserve(binding, limits),
        accounting.reserve({...binding, generation: 8}, limits),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(accounting.snapshot().rows).toHaveLength(1);
      expect(accounting.snapshot().rows[0]?.dayUtc).toBe('2026-09-10');
    } finally {
      await accounting.close();
    }
  });

  it('settles once and rejects a second settlement without double counting', async () => {
    const path = await databasePath();
    const accounting = createApiAccounting(path, () => Date.parse('2026-09-10T12:00:00.000Z'));
    try {
      const reservation = await accounting.reserve(binding, limits);
      expect(reservation).not.toBeNull();
      await accounting.markDispatch(reservation!.id);
      await accounting.settle(reservation!.id, usage);
      await expect(accounting.settle(reservation!.id, usage)).rejects.toThrow('API_SETTLEMENT_ALREADY_APPLIED');
      expect(accounting.snapshot()).toMatchObject({knownTokens: 4, unknown: 0, unresolved: 0});
    } finally {
      await accounting.close();
    }
  });

  it('keeps an undisclosed dispatched reservation counted after restart', async () => {
    const path = await databasePath();
    const first = createApiAccounting(path, () => Date.parse('2026-09-10T12:00:00.000Z'));
    const reservation = await first.reserve(binding, limits);
    expect(reservation).not.toBeNull();
    await first.markDispatch(reservation!.id);
    await first.close();

    const reopened = createApiAccounting(path, () => Date.parse('2026-09-10T12:01:00.000Z'));
    try {
      expect(reopened.snapshot()).toMatchObject({unknown: 1, unresolved: 1});
      expect(await reopened.reserve({...binding, generation: 8}, limits)).toBeNull();
    } finally {
      await reopened.close();
    }
  });

  it('releases only a proven pre-dispatch cancellation and preserves its history', async () => {
    const path = await databasePath();
    const accounting = createApiAccounting(path, () => Date.parse('2026-09-10T12:00:00.000Z'));
    try {
      const cancelled = await accounting.reserve(binding, limits);
      expect(cancelled).not.toBeNull();
      await accounting.cancelBeforeDispatch(cancelled!.id);
      expect(await accounting.reserve({...binding, generation: 8}, limits)).not.toBeNull();
      expect(accounting.snapshot().rows.map(row => row.state)).toEqual(expect.arrayContaining(['cancelled', 'pending']));
      await expect(accounting.cancelBeforeDispatch(cancelled!.id)).rejects.toThrow('API_RESERVATION_NOT_PENDING');
    } finally {
      await accounting.close();
    }
  });

  it('records missing usage as unknown and keeps the reservation counted', async () => {
    const path = await databasePath();
    const accounting = createApiAccounting(path, () => Date.parse('2026-09-10T12:00:00.000Z'));
    try {
      const reservation = await accounting.reserve(binding, limits);
      expect(reservation).not.toBeNull();
      await accounting.settle(reservation!.id, null);
      expect(readFixtureRows(path).at(-1)?.usageState).toBe('unknown');
      expect(accounting.snapshot()).toMatchObject({unknown: 1, unresolved: 0});
    } finally {
      await accounting.close();
    }
  });

  it('does not claim dollar-cap enforcement when cached-input pricing is uncovered', async () => {
    const path = await databasePath();
    const accounting = createApiAccounting(path, () => Date.parse('2026-09-10T12:00:00.000Z'));
    try {
      const reservation = await accounting.reserve(binding, {
        ...limits,
        dailyMicrousdCap: 10_000,
        prices: {
          version: 'v1',
          source: 'fixture',
          effectiveDate: '2026-09-10',
          inputMicrousdPerMillion: 1_000,
          outputMicrousdPerMillion: 2_000,
        },
      });
      expect(reservation).not.toBeNull();
      expect(accounting.snapshot().rows[0]?.costState).toBe('unknown');
      expect(accounting.snapshot().rows[0]?.reservedMicrousd).toBeNull();
      expect(accounting.snapshot().dollarCapEnforced).toBe(false);
    } finally {
      await accounting.close();
    }
  });

  it('rejects malformed limits, closed owners, and corrupt databases', async () => {
    const path = await databasePath();
    const accounting = createApiAccounting(path, () => Date.parse('2026-09-10T12:00:00.000Z'));
    await expect(accounting.reserve(binding, {...limits, dailyTokenCap: -1})).rejects.toThrow('API_INVALID_LIMITS');
    await accounting.close();
    await expect(accounting.reserve(binding, limits)).rejects.toThrow('API_ACCOUNTING_CLOSED');

    const corruptPath = await databasePath();
    const corrupt = new DatabaseSync(corruptPath);
    corrupt.exec('CREATE TABLE api_reservations (id TEXT PRIMARY KEY)');
    corrupt.close();
    expect(() => createApiAccounting(corruptPath, () => Date.parse('2026-09-10T12:00:00.000Z'))).toThrow('API_ACCOUNTING_CORRUPT');
  });

  it('reads the clock for each reservation and starts a new UTC bucket without reopening', async () => {
    const path = await databasePath();
    let now = Date.parse('2026-09-10T23:59:59.999Z');
    const accounting = createApiAccounting(path, () => now);
    try {
      expect(await accounting.reserve(binding, limits)).not.toBeNull();
      now = Date.parse('2026-09-11T00:00:00.000Z');
      expect(await accounting.reserve({...binding, generation: 8}, limits)).not.toBeNull();
      expect(accounting.snapshot().rows.map(row => row.dayUtc)).toEqual(['2026-09-10', '2026-09-11']);
    } finally {
      await accounting.close();
    }
  });

  it('keeps daily call admission across generation changes and bounds diagnostic rows', async () => {
    const path = await databasePath();
    let now = Date.parse('2026-09-10T12:00:00.000Z');
    const accounting = createApiAccounting(path, () => now);
    try {
      expect(await accounting.reserve(binding, limits)).not.toBeNull();
      expect(await accounting.reserve({...binding, generation: 8}, {...limits, maxInputTokens: 1, maxOutputTokens: 1})).toBeNull();
      now = Date.parse('2026-09-11T12:00:00.000Z');
      expect(await accounting.reserve({...binding, generation: 9}, limits)).not.toBeNull();
      expect(accounting.snapshot({rowLimit: 1}).rows).toHaveLength(1);
      expect(accounting.snapshot({rowLimit: 1}).rowsTruncated).toBe(true);
      expect(accounting.snapshot().starts).toBe(2);
    } finally {
      await accounting.close();
    }
  });

  it('serializes admission across separate SQLite owners', async () => {
    const path = await databasePath();
    const directory = dirname(path);
    const source = pathToFileURL(join(process.cwd(), 'src/estimation/observer-api-accounting.ts')).href;
    const worker = join(directory, 'reserve-worker.mjs');
    const barrier = join(directory, 'start.reserve');
    const workerSource = `
      import { existsSync, writeFileSync } from 'node:fs';
      const source = process.argv[2];
      const path = process.argv[3];
      const now = Number(process.argv[4]);
      const generation = Number(process.argv[5]);
      const ready = process.argv[6];
      const barrier = process.argv[7];
      const { createApiAccounting } = await import(source);
      const accounting = createApiAccounting(path, () => now);
      writeFileSync(ready, 'ready');
      while (!existsSync(barrier)) await new Promise(resolve => setTimeout(resolve, 2));
      const result = await accounting.reserve({kind: 'api', profileId: 'profile-a', generation}, {
        dailyCallLimit: 1, dailyTokenCap: 10, maxInputTokens: 4, maxOutputTokens: 2,
      });
      process.stdout.write(result === null ? 'null' : 'reserved');
      await accounting.close();
    `;
    const priming = createApiAccounting(path, () => Date.parse('2026-09-10T12:00:00.000Z'));
    await priming.close();
    await writeFile(worker, workerSource);
    const now = String(Date.parse('2026-09-10T12:00:00.000Z'));
    const readyPaths = [join(directory, 'ready-1'), join(directory, 'ready-2'), join(directory, 'ready-3'), join(directory, 'ready-4')];
    const workers = readyPaths.map((ready, index) => execFileAsync(process.execPath, [
      '--no-warnings', '--experimental-strip-types', worker, source, path, now, String(index + 1), ready, barrier,
    ], {maxBuffer: 1_000_000, timeout: 10_000}));
    for (const child of workers) void child.catch(() => undefined);
    try {
      for (const ready of readyPaths) {
        for (let attempt = 0; attempt < 200; attempt++) {
          try { await access(ready); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
        }
        await access(ready);
      }
      await writeFile(barrier, 'go');
      const results = await Promise.all(workers);
      expect(results.map(result => result.stdout.trim()).filter(value => value === 'reserved')).toHaveLength(1);
      expect(results.map(result => result.stdout.trim()).filter(value => value === 'null')).toHaveLength(3);
    } finally {
      await writeFile(barrier, 'release').catch(() => undefined);
      await Promise.allSettled(workers);
    }
  });

  it('blocks newly enabled dollar enforcement after same-day unpriced history', async () => {
    const path = await databasePath();
    const accounting = createApiAccounting(path, () => Date.parse('2026-09-10T12:00:00.000Z'));
    const pricedLimits: ApiLimits = {
      dailyCallLimit: 3,
      maxInputTokens: 3,
      maxOutputTokens: 1,
      dailyMicrousdCap: 10,
      prices: {
        version: 'v1', source: 'fixture', effectiveDate: '2026-09-10',
        inputMicrousdPerMillion: 1_000_000,
        outputMicrousdPerMillion: 1_000_000,
        cachedInputMicrousdPerMillion: 500_000,
      },
    };
    try {
      const unpricedLimits: ApiLimits = {...pricedLimits};
      delete unpricedLimits.dailyMicrousdCap;
      delete unpricedLimits.prices;
      const prior = await accounting.reserve(binding, unpricedLimits);
      expect(prior).not.toBeNull();
      await accounting.settle(prior!.id, usage);
      const enabled = await accounting.reserve({...binding, generation: 8}, pricedLimits);
      expect(enabled).not.toBeNull();
      expect(accounting.snapshot().rows.find(row => row.generation === 8)?.costState).toBe('unknown');
      expect(accounting.snapshot().dollarCapEnforced).toBe(false);
    } finally {
      await accounting.close();
    }
  });

  it('includes known priced history when enforcing a later reservation', async () => {
    const path = await databasePath();
    const accounting = createApiAccounting(path, () => Date.parse('2026-09-10T12:00:00.000Z'));
    const pricedLimits: ApiLimits = {
      dailyCallLimit: 3,
      maxInputTokens: 3,
      maxOutputTokens: 1,
      dailyMicrousdCap: 5,
      prices: {
        version: 'v1', source: 'fixture', effectiveDate: '2026-09-10',
        inputMicrousdPerMillion: 1_000_000,
        outputMicrousdPerMillion: 1_000_000,
        cachedInputMicrousdPerMillion: 500_000,
      },
    };
    try {
      const first = await accounting.reserve(binding, pricedLimits);
      expect(first).not.toBeNull();
      await accounting.settle(first!.id, usage);
      expect(await accounting.reserve({...binding, generation: 8}, pricedLimits)).toBeNull();
    } finally {
      await accounting.close();
    }
  });
});
