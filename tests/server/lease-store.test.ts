import { describe, expect, it, vi } from "vitest";
import { LeaseStore } from "../../src/server/lease-store.js";

describe("LeaseStore", () => {
  it("creates opaque bounded leases and renews only for the owner", () => {
    let now = 10_000;
    const store = new LeaseStore({ now: () => now, randomUUID: () => "lease-uuid" });

    const lease = store.acquire("owner-a", 60_000);

    expect(lease).toEqual({
      id: "lease_lease-uuid",
      ownerNonce: "owner-a",
      expiresAt: 70_000
    });
    expect(store.renew(lease.id, "wrong-owner", 60_000)).toBeNull();
    expect(store.renew(lease.id, "owner-a", 60_000)).toEqual({
      ...lease,
      expiresAt: 70_000
    });
  });

  it("clamps requested TTLs to safe bounds", () => {
    let now = 1_000;
    const store = new LeaseStore({
      now: () => now,
      minTtlMs: 5_000,
      maxTtlMs: 20_000,
      defaultTtlMs: 10_000
    });

    expect(store.acquire("short", 1).expiresAt).toBe(6_000);
    expect(store.acquire("long", 999_999).expiresAt).toBe(21_000);
    expect(store.acquire("default").expiresAt).toBe(11_000);
  });

  it("expires leases only after the injected clock reaches the deadline", () => {
    let now = 0;
    const store = new LeaseStore({ now: () => now, minTtlMs: 1, maxTtlMs: 100, defaultTtlMs: 100 });
    const lease = store.acquire("owner");

    now = 99;
    expect(store.sweep()).toBe(0);
    expect(store.active()).toHaveLength(1);
    now = 100;
    expect(store.sweep()).toBe(1);
    expect(store.active()).toEqual([]);
    expect(store.release(lease.id, "owner")).toBe(false);
  });

  it("routes release at the expiry deadline through the expiry transition", () => {
    let now = 0;
    const store = new LeaseStore({ now: () => now, minTtlMs: 1, maxTtlMs: 100, defaultTtlMs: 10 });
    const expired = vi.fn();
    const released = vi.fn();
    store.on("expired", expired);
    store.on("released", released);
    const lease = store.acquire("owner", 10);
    store.bind(lease.id, "owner", "hud_aaaaaaaaaaaaaaaaaaaa");

    now = 10;

    expect(store.release(lease.id, "owner")).toBe(false);
    expect(expired).toHaveBeenCalledWith({
      lease,
      taskHandles: ["hud_aaaaaaaaaaaaaaaaaaaa"]
    });
    expect(released).not.toHaveBeenCalled();
    expect(store.active()).toEqual([]);
  });

  it("never moves lease time backwards when the injected clock rolls back", () => {
    let now = 100;
    const store = new LeaseStore({ now: () => now, minTtlMs: 10, maxTtlMs: 10, defaultTtlMs: 10 });
    const lease = store.acquire("owner");

    now = 40;
    expect(store.renew(lease.id, "owner")).toEqual(lease);
    expect(store.sweep()).toBe(0);

    now = 110;
    expect(store.sweep()).toBe(1);
    expect(store.active()).toEqual([]);
  });

  it("checks owner capabilities and preserves task binding isolation", () => {
    const store = new LeaseStore({ randomUUID: (() => {
      let index = 0;
      return () => `id-${++index}`;
    })() });
    const first = store.acquire("owner-a");
    const second = store.acquire("owner-b");

    expect(store.bind(first.id, "owner-a", "hud_aaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(store.authorize(first.id, "owner-a", "hud_aaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(store.authorize(second.id, "owner-b", "hud_aaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(store.bind(first.id, "owner-b", "hud_bbbbbbbbbbbbbbbbbbbb")).toBe(false);
    expect(store.release(first.id, "owner-b")).toBe(false);
    expect(store.active()).toHaveLength(2);
  });

  it("allows one owner to bind multiple handles but never leaks bindings", () => {
    const store = new LeaseStore();
    const lease = store.acquire("owner");

    expect(store.bind(lease.id, "owner", "hud_aaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(store.bind(lease.id, "owner", "hud_bbbbbbbbbbbbbbbbbbbb")).toBe(true);
    expect(store.boundHandles(lease.id, "owner")).toEqual([
      "hud_aaaaaaaaaaaaaaaaaaaa",
      "hud_bbbbbbbbbbbbbbbbbbbb"
    ]);
    expect(store.boundHandles(lease.id, "wrong")).toEqual([]);
  });
});
