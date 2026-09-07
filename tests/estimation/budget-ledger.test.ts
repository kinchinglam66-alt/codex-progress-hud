import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBudgetLedger } from "../../src/estimation/budget-ledger.js";
const directories: string[] = [];
async function dir() { const path = await mkdtemp(join(tmpdir(), "hud-budget-test-")); directories.push(path); return path; }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("durable conservative test budget", () => {
  it("serializes reservations and retains consumed capacity across reopen", async () => {
    const path = await dir(); const ledger = await openBudgetLedger(path, 20);
    try { expect(await Promise.all([ledger.reserve(10), ledger.reserve(10), ledger.reserve(1)])).toEqual([true, true, false]); }
    finally { await ledger.close(); }
    const reopened = await openBudgetLedger(path, 20);
    try { expect(await reopened.reserve(1)).toBe(false); }
    finally { await reopened.close(); }
  });
  it("excludes a second owner and refuses to increase a persisted budget implicitly", async () => {
    const path = await dir(); const ledger = await openBudgetLedger(path, 20);
    try { await expect(openBudgetLedger(path, 20)).rejects.toThrow(); }
    finally { await ledger.close(); }
    await expect(openBudgetLedger(path, 21)).rejects.toThrow("BUDGET_LIMIT_MISMATCH");
    const reopened = await openBudgetLedger(path, 20); await reopened.close();
  });
  it("fails closed on partial or corrupt journal instead of resetting money", async () => {
    const path = await dir(); const ledger = await openBudgetLedger(path, 20);
    await ledger.reserve(10); await ledger.close();
    const file = join(path, "estimator-budget.jsonl");
    const before = await readFile(file, "utf8"); await writeFile(file, before + '{"reserved');
    await expect(openBudgetLedger(path, 20)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(before + '{"reserved');
  });
  it("rejects invalid amounts and reservations after close", async () => {
    const path = await dir(); const ledger = await openBudgetLedger(path, 20);
    await expect(ledger.reserve(-1)).rejects.toThrow();
    await expect(ledger.reserve(0.1)).rejects.toThrow();
    await ledger.close(); expect(await ledger.reserve(1)).toBe(false);
  });
});
