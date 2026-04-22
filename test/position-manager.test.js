/**
 * @file test/position-manager.test.js
 * @description Tests for the multi-position orchestrator.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPositionManager } = require("../src/position-manager");
const { createRebalanceLock } = require("../src/rebalance-lock");

/** Create a fake startLoop that returns a stoppable handle. */
function fakeStartLoop() {
  let stopped = false;
  return async () => ({
    stop() {
      stopped = true;
      return Promise.resolve();
    },
    get stopped() {
      return stopped;
    },
  });
}

/** Shorthand to build a manager with defaults. */
function makeMgr(overrides) {
  return createPositionManager({
    rebalanceLock: createRebalanceLock(),
    dailyMax: 20,
    ...overrides,
  });
}

describe("position-manager", () => {
  // ── startPosition ───────────────────────────────────────────────────────

  describe("startPosition()", () => {
    it("starts a position and registers it as running", async () => {
      const mgr = makeMgr();
      await mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: fakeStartLoop(),
      });
      assert.equal(mgr.count(), 1);
      assert.equal(mgr.runningCount(), 1);
      const entry = mgr.get("key-1");
      assert.equal(entry.status, "running");
      assert.equal(entry.tokenId, "100");
    });

    it("no-ops when position is already running (no duplicate loop)", async () => {
      const mgr = makeMgr();
      let callCount = 0;
      const loop = async () => {
        callCount++;
        return { stop: () => Promise.resolve() };
      };
      await mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: loop,
      });
      await mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: loop,
      });
      await mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: loop,
      });
      assert.equal(
        callCount,
        1,
        "startLoop must be called exactly once — no duplicate bot loops",
      );
      assert.equal(
        mgr.runningCount(),
        1,
        "only one position should be running",
      );
    });

    it("exposes lock and scan helpers on the manager", async () => {
      const lock = createRebalanceLock();
      const mgr = createPositionManager({ rebalanceLock: lock });
      await mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: fakeStartLoop(),
      });
      assert.equal(typeof mgr.getRebalanceLock, "function");
      assert.equal(typeof mgr.getScanLock, "function");
    });
  });

  // ── removePosition ──────────────────────────────────────────────────────

  describe("removePosition()", () => {
    it("stops and removes the position", async () => {
      const mgr = makeMgr();
      let stopped = false;
      const loop = async () => ({
        stop() {
          stopped = true;
          return Promise.resolve();
        },
      });
      await mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: loop,
      });
      await mgr.removePosition("key-1");
      assert.ok(stopped);
      assert.equal(mgr.count(), 0);
      assert.equal(mgr.get("key-1"), undefined);
    });

    it("no-ops on unknown key", async () => {
      const mgr = makeMgr();
      await mgr.removePosition("nonexistent"); // should not throw
    });
  });

  // ── stopAll ─────────────────────────────────────────────────────────────

  describe("stopAll()", () => {
    it("stops all running positions", async () => {
      const mgr = makeMgr();
      const stops = [];
      const makeLoop = () => async () => ({
        stop() {
          stops.push(true);
          return Promise.resolve();
        },
      });
      await mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: makeLoop(),
      });
      await mgr.startPosition("key-2", {
        tokenId: "200",
        startLoop: makeLoop(),
      });
      await mgr.stopAll();
      assert.equal(stops.length, 2);
      assert.equal(mgr.runningCount(), 0);
    });
  });

  // ── migrateKey ──────────────────────────────────────────────────────────

  describe("migrateKey()", () => {
    it("moves entry from old key to new key", async () => {
      const mgr = makeMgr();
      await mgr.startPosition("old-key", {
        tokenId: "100",
        startLoop: fakeStartLoop(),
      });
      mgr.migrateKey("old-key", "new-key", "200");
      assert.equal(mgr.get("old-key"), undefined);
      const entry = mgr.get("new-key");
      assert.equal(entry.tokenId, "200");
      assert.equal(entry.status, "running");
    });

    it("no-ops when old === new", async () => {
      const mgr = makeMgr();
      await mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: fakeStartLoop(),
      });
      mgr.migrateKey("key-1", "key-1", "100");
      assert.equal(mgr.get("key-1").tokenId, "100");
    });
  });

  // ── getAll ──────────────────────────────────────────────────────────────

  describe("getAll()", () => {
    it("returns summary of all managed positions", async () => {
      const mgr = makeMgr();
      await mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: fakeStartLoop(),
      });
      await mgr.startPosition("key-2", {
        tokenId: "200",
        startLoop: fakeStartLoop(),
      });

      const all = mgr.getAll();
      assert.equal(all.length, 2);
      assert.ok(all.find((p) => p.key === "key-1" && p.status === "running"));
      assert.ok(all.find((p) => p.key === "key-2" && p.status === "running"));
    });
  });

  // ── Multiple positions with shared lock ─────────────────────────────────

  describe("multiple positions", () => {
    it("can manage multiple positions simultaneously", async () => {
      const mgr = makeMgr();
      await mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: fakeStartLoop(),
      });
      await mgr.startPosition("key-2", {
        tokenId: "200",
        startLoop: fakeStartLoop(),
      });
      assert.equal(mgr.count(), 2);
      assert.equal(mgr.runningCount(), 2);
    });
  });

  describe("getPoolScanLock", () => {
    it("returns same mutex for same pool key", () => {
      const mgr = createPositionManager({
        rebalanceLock: createRebalanceLock(),
      });
      const a = mgr.getPoolScanLock("0xa-0xb-3000");
      const b = mgr.getPoolScanLock("0xa-0xb-3000");
      assert.equal(a, b);
    });

    it("returns different mutex for different pool keys", () => {
      const mgr = createPositionManager({
        rebalanceLock: createRebalanceLock(),
      });
      const a = mgr.getPoolScanLock("0xa-0xb-3000");
      const b = mgr.getPoolScanLock("0xa-0xb-10000");
      assert.notEqual(a, b);
    });

    it("is independent from global scan lock", () => {
      const mgr = createPositionManager({
        rebalanceLock: createRebalanceLock(),
      });
      const global = mgr.getScanLock();
      const pool = mgr.getPoolScanLock("0xa-0xb-3000");
      assert.notEqual(global, pool);
    });
  });

  // ── pool daily counts ───────────────────────────────────────────────

  describe("poolKey()", () => {
    it("normalizes and sorts token addresses", () => {
      const mgr = makeMgr();
      const k1 = mgr.poolKey("0xAAA", "0xBBB", 3000);
      const k2 = mgr.poolKey("0xBBB", "0xAAA", 3000);
      assert.strictEqual(k1, k2);
    });

    it("includes fee in the key", () => {
      const mgr = makeMgr();
      const k1 = mgr.poolKey("0xa", "0xb", 3000);
      const k2 = mgr.poolKey("0xa", "0xb", 500);
      assert.notStrictEqual(k1, k2);
    });
  });

  describe("canRebalancePool()", () => {
    it("returns true when count is below max", () => {
      const mgr = makeMgr();
      const pk = mgr.poolKey("0xa", "0xb", 3000);
      assert.strictEqual(mgr.canRebalancePool(pk, 5), true);
    });

    it("returns false after reaching max", () => {
      const mgr = makeMgr();
      const pk = mgr.poolKey("0xa", "0xb", 3000);
      for (let i = 0; i < 5; i++) mgr.recordPoolRebalance(pk);
      assert.strictEqual(mgr.canRebalancePool(pk, 5), false);
    });
  });

  describe("recordPoolRebalance()", () => {
    it("increments pool daily count", () => {
      const mgr = makeMgr();
      const pk = mgr.poolKey("0xa", "0xb", 3000);
      mgr.recordPoolRebalance(pk);
      mgr.recordPoolRebalance(pk);
      const counts = mgr.getPoolDailyCounts();
      assert.strictEqual(counts[pk], 2);
    });
  });

  describe("getPoolDailyCounts()", () => {
    it("returns empty object initially", () => {
      const mgr = makeMgr();
      assert.deepStrictEqual(mgr.getPoolDailyCounts(), {});
    });

    it("resets at midnight boundary", () => {
      // Use a custom clock that jumps past midnight
      let now = Date.now();
      const mgr = createPositionManager({
        rebalanceLock: createRebalanceLock(),
        nowFn: () => now,
      });
      const pk = mgr.poolKey("0xa", "0xb", 3000);
      mgr.recordPoolRebalance(pk);
      assert.strictEqual(mgr.getPoolDailyCounts()[pk], 1);
      // Jump 25 hours into the future
      now += 25 * 60 * 60 * 1000;
      assert.deepStrictEqual(mgr.getPoolDailyCounts(), {});
    });
  });

  // ── seedPoolDailyCounts ─────────────────────────────────────────────────

  describe("seedPoolDailyCounts()", () => {
    /*- Use a fixed clock so we can construct log timestamps relative to
     *  "today" deterministically. */
    function fixedClockMgr(now) {
      return createPositionManager({
        rebalanceLock: createRebalanceLock(),
        nowFn: () => now,
      });
    }

    it("counts today-UTC log entries and skips older ones", () => {
      const now = Date.UTC(2026, 3, 22, 15, 0, 0); // Apr 22 2026 15:00 UTC
      const mgr = fixedClockMgr(now);
      const todayStart = Date.UTC(2026, 3, 22, 0, 0, 0);
      const yesterday = Date.UTC(2026, 3, 21, 23, 0, 0);
      const entries = [
        {
          token0: "0xA",
          token1: "0xB",
          fee: 3000,
          loggedAt: new Date(todayStart + 60_000).toISOString(),
        },
        {
          token0: "0xA",
          token1: "0xB",
          fee: 3000,
          loggedAt: new Date(now - 60_000).toISOString(),
        },
        {
          token0: "0xA",
          token1: "0xB",
          fee: 3000,
          loggedAt: new Date(yesterday).toISOString(),
        },
      ];
      const n = mgr.seedPoolDailyCounts(entries);
      assert.strictEqual(n, 2);
      const pk = mgr.poolKey("0xA", "0xB", 3000);
      assert.strictEqual(mgr.getPoolDailyCount(pk), 2);
    });

    it("skips entries missing token0/token1/fee", () => {
      const now = Date.UTC(2026, 3, 22, 15, 0, 0);
      const mgr = fixedClockMgr(now);
      const iso = new Date(now - 60_000).toISOString();
      const n = mgr.seedPoolDailyCounts([
        { loggedAt: iso, poolAddress: "0xpool" }, // pre-fix row
        { token0: "0xA", fee: 3000, loggedAt: iso }, // missing token1
        { token0: "0xA", token1: "0xB", loggedAt: iso }, // missing fee
        { token0: "0xA", token1: "0xB", fee: 3000, loggedAt: iso }, // valid
      ]);
      assert.strictEqual(n, 1);
    });

    it("groups separate pools into distinct counts", () => {
      const now = Date.UTC(2026, 3, 22, 15, 0, 0);
      const mgr = fixedClockMgr(now);
      const iso = new Date(now - 60_000).toISOString();
      const mk = (t0, t1, f) => ({
        token0: t0,
        token1: t1,
        fee: f,
        loggedAt: iso,
      });
      mgr.seedPoolDailyCounts([
        mk("0xA", "0xB", 3000),
        mk("0xA", "0xB", 3000),
        mk("0xC", "0xD", 500),
      ]);
      const counts = mgr.getPoolDailyCounts();
      assert.strictEqual(counts[mgr.poolKey("0xA", "0xB", 3000)], 2);
      assert.strictEqual(counts[mgr.poolKey("0xC", "0xD", 500)], 1);
    });

    it("returns 0 for empty / non-array input", () => {
      const mgr = makeMgr();
      assert.strictEqual(mgr.seedPoolDailyCounts([]), 0);
      assert.strictEqual(mgr.seedPoolDailyCounts(null), 0);
      assert.strictEqual(mgr.seedPoolDailyCounts(undefined), 0);
    });

    it("is additive — subsequent live rebalances continue counting", () => {
      const now = Date.UTC(2026, 3, 22, 15, 0, 0);
      const mgr = fixedClockMgr(now);
      const iso = new Date(now - 60_000).toISOString();
      mgr.seedPoolDailyCounts([
        { token0: "0xA", token1: "0xB", fee: 3000, loggedAt: iso },
        { token0: "0xA", token1: "0xB", fee: 3000, loggedAt: iso },
      ]);
      const pk = mgr.poolKey("0xA", "0xB", 3000);
      mgr.recordPoolRebalance(pk);
      assert.strictEqual(mgr.getPoolDailyCount(pk), 3);
    });
  });
});
