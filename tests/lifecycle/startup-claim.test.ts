import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStartupClaimStore } from "../../src/lifecycle/startup-claim.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function claimDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hud-startup-claim-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("startup claim", () => {
  it("allows only one concurrent manager to claim a generation", async () => {
    const directory = await claimDirectory();
    const first = createStartupClaimStore(directory, { now: () => 100 });
    const second = createStartupClaimStore(directory, { now: () => 100 });

    const [left, right] = await Promise.all([
      first.tryAcquire(7, 1_000),
      second.tryAcquire(7, 1_000)
    ]);

    expect([left.kind, right.kind].sort()).toEqual(["acquired", "held"]);
    if (left.kind === "acquired") {
      expect(right).toMatchObject({ kind: "held", claim: { generation: 7, expiresAt: 1_000 } });
      await left.lease.release();
    } else {
      expect(left).toMatchObject({ kind: "held", claim: { generation: 7, expiresAt: 1_000 } });
      if (right.kind !== "acquired") throw new Error("expected right manager to acquire");
      await right.lease.release();
    }
  });

  it("takes over an expired claim and does not let the old owner release it", async () => {
    const directory = await claimDirectory();
    let clock = 100;
    const first = createStartupClaimStore(directory, { now: () => clock });
    const second = createStartupClaimStore(directory, { now: () => clock });
    const original = await first.tryAcquire(3, 200);
    expect(original.kind).toBe("acquired");
    if (original.kind !== "acquired") throw new Error("expected original claim");

    clock = 201;
    const replacement = await second.tryAcquire(3, 1_000);
    expect(replacement.kind).toBe("acquired");
    if (replacement.kind !== "acquired") throw new Error("expected replacement claim");
    expect(replacement.lease.ownerNonce).not.toBe(original.lease.ownerNonce);

    await original.lease.release();
    const claimText = await readFile(join(directory, ".companion-startup-claim.json"), "utf8");
    expect(JSON.parse(claimText)).toMatchObject({
      generation: 3,
      ownerNonce: replacement.lease.ownerNonce,
      expiresAt: 1_000
    });
    await replacement.lease.release();
  });

  it("attaches to a claim during the transient hard-link publication window", async () => {
    const directory = await claimDirectory();
    const claimPath = join(directory, ".companion-startup-claim.json");
    const publicationLink = join(directory, ".companion-startup-claim.publication");
    await writeFile(claimPath, JSON.stringify({ generation: 5, ownerNonce: "owner", expiresAt: 1_000 }));
    await link(claimPath, publicationLink);

    const result = await createStartupClaimStore(directory, { now: () => 100 }).tryAcquire(5, 1_000);

    expect(result).toMatchObject({ kind: "held", claim: { generation: 5, ownerNonce: "owner" } });
    await rm(publicationLink, { force: true });
  });

  it("rejects an oversized claim before parsing its contents", async () => {
    const directory = await claimDirectory();
    const claimPath = join(directory, ".companion-startup-claim.json");
    await writeFile(claimPath, `{"generation":5,"ownerNonce":"${"x".repeat(1_100)}","expiresAt":1000}`);

    await expect(
      createStartupClaimStore(directory, { now: () => 100 }).tryAcquire(5, 1_000)
    ).rejects.toThrow("startup claim is too large");
  });
});
