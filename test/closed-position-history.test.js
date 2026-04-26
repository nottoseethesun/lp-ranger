/**
 * @file test/closed-position-history.test.js
 * @description Tests for the GET /api/position/:tokenId/history endpoint.
 * Exercises the getPositionHistory() helper directly with known rebalance_log.json data.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const TMP = path.join(process.cwd(), "tmp");
const LOG_PATH = path.join(TMP, "test-rebalance-log.json");

/**
 * Offline ethers stub used by the whole describe block. position-history.js
 * (and its helpers) require `ethers` at module load AND construct a cached
 * `new ethers.Interface(PM_ABI)` at module load. We must install the
 * `Module.prototype.require` patch BEFORE loading position-history so that
 * top-of-file binding resolves to the stub rather than real ethers (otherwise
 * the helpers instantiate a real JsonRpcProvider and each test waits ~60s
 * for RPC timeouts — blowing past the CI budget).
 */
const _origRequire = Module.prototype.require;
const _ethersStub = {
  JsonRpcProvider: class {
    async getBlockNumber() {
      return 0;
    }
    async getLogs() {
      return [];
    }
    async getBlock() {
      return null;
    }
    destroy() {}
  },
  Contract: class {
    async getPool() {
      return "0x0000000000000000000000000000000000000000";
    }
    async positions() {
      return null;
    }
  },
  Interface: class {
    getEvent() {
      return { topicHash: "0x" + "0".repeat(64) };
    }
    parseLog() {
      return null;
    }
  },
  ZeroAddress: "0x0000000000000000000000000000000000000000",
};

/*- Install BEFORE loading position-history so module-load-time `require` and
    `new ethers.Interface(PM_ABI)` see the stub. Restored in after(). */
Module.prototype.require = function (id) {
  if (id === "ethers") return _ethersStub;
  return _origRequire.apply(this, arguments);
};

const config = require("../src/config");
const { getPositionHistory } = require("../src/position-history");

/**
 * Stub fetch so `_supplementHistoricalPrices` inside `getPositionHistory`
 * does NOT hit real GeckoTerminal / DexScreener during tests. Before this
 * stub, these tests took ~60s each because each call did a real network
 * round-trip (and after the 429-retry change, ~7 minutes — which blew past
 * the CI budget). The tests don't depend on actual prices — they just verify
 * timestamp / txHash supplementation — so an empty-list response is fine.
 */
function _installOfflineFetchStub() {
  return async (url) => {
    // DexScreener shape
    if (typeof url === "string" && url.includes("dexscreener.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ pairs: [] }),
      };
    }
    // GeckoTerminal OHLCV / pool-info shape
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
    };
  };
}

describe("getPositionHistory", () => {
  let origLogFile = null;
  let origFetch = null;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    origLogFile = config.LOG_FILE;
    config.LOG_FILE = "tmp/test-rebalance-log.json";
    origFetch = globalThis.fetch;
    globalThis.fetch = _installOfflineFetchStub();

    const testEntries = [
      {
        oldTokenId: "100",
        newTokenId: "200",
        loggedAt: "2026-01-15T10:00:00Z",
        entryValueUsd: 1000,
        exitValueUsd: 1050,
        token0UsdPrice: 0.5,
        token1UsdPrice: 1.0,
        feesEarnedUsd: 25,
        gasCostWei: "500000",
      },
      {
        oldTokenId: "200",
        newTokenId: "300",
        loggedAt: "2026-02-20T14:30:00Z",
        entryValueUsd: 1050,
        exitValueUsd: 1100,
        token0UsdPrice: 0.55,
        token1UsdPrice: 1.1,
        feesEarnedUsd: 30,
        gasCostWei: "600000",
      },
    ];
    fs.writeFileSync(LOG_PATH, JSON.stringify(testEntries), "utf8");
  });

  after(() => {
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* */
    }
    if (origLogFile !== null) config.LOG_FILE = origLogFile;
    if (origFetch) globalThis.fetch = origFetch;
    Module.prototype.require = _origRequire;
  });

  it("returns mint and close data for a mid-chain tokenId (200)", async () => {
    const body = await getPositionHistory("200", {});
    assert.strictEqual(body.tokenId, "200");
    assert.strictEqual(body.entryValueUsd, 1000);
    assert.strictEqual(body.mintDate, "2026-01-15T10:00:00Z");
    assert.strictEqual(body.token0UsdPriceAtOpen, 0.5);
    assert.strictEqual(body.exitValueUsd, 1100);
    assert.strictEqual(body.closeDate, "2026-02-20T14:30:00Z");
    assert.strictEqual(body.feesEarnedUsd, 30);
  });

  it("returns mint data only for the latest tokenId (300)", async () => {
    const body = await getPositionHistory("300", {});
    assert.strictEqual(body.entryValueUsd, 1050);
    assert.strictEqual(body.mintDate, "2026-02-20T14:30:00Z");
    assert.strictEqual(body.exitValueUsd, null);
    assert.strictEqual(body.closeDate, null);
  });

  it("returns close data only for the first tokenId (100)", async () => {
    const body = await getPositionHistory("100", {});
    assert.strictEqual(body.entryValueUsd, null);
    assert.strictEqual(body.exitValueUsd, 1050);
    assert.strictEqual(body.closeDate, "2026-01-15T10:00:00Z");
  });

  it("returns nulls for USD values when tokenId has no log entry", async () => {
    const body = await getPositionHistory("99999", {});
    assert.strictEqual(body.tokenId, "99999");
    assert.strictEqual(body.closeDate, null);
    assert.strictEqual(body.entryValueUsd, null);
    assert.strictEqual(body.exitValueUsd, null);
  });

  it("supplements timestamps and txHash from rebalanceEvents", async () => {
    fs.writeFileSync(
      LOG_PATH,
      JSON.stringify([{ oldTokenId: "400", newTokenId: "500" }]),
      "utf8",
    );
    const events = [
      {
        oldTokenId: "400",
        newTokenId: "500",
        timestamp: 1700000000,
        txHash: "0xabc123",
      },
    ];

    const body = await getPositionHistory("500", {
      rebalanceEvents: events,
    });
    assert.ok(
      body.mintDate,
      "mintDate should be populated from rebalanceEvents",
    );
    assert.ok(body.mintDate.includes("2023"));
    assert.strictEqual(body.mintTxHash, "0xabc123");

    const body2 = await getPositionHistory("400", {
      rebalanceEvents: events,
    });
    assert.ok(body2.closeDate);
    assert.strictEqual(body2.closeTxHash, "0xabc123");
  });

  it("returns dates from events even with no rebalance log file", async () => {
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* already gone */
    }
    const events = [
      {
        oldTokenId: "600",
        newTokenId: "700",
        timestamp: 1700000000,
        txHash: "0xdef456",
      },
    ];

    const body = await getPositionHistory("700", {
      rebalanceEvents: events,
    });
    assert.strictEqual(body.tokenId, "700");
    assert.ok(body.mintDate);
    assert.strictEqual(body.mintTxHash, "0xdef456");
    assert.strictEqual(body.entryValueUsd, null);

    fs.writeFileSync(LOG_PATH, "[]", "utf8");
  });

  it("handles missing log file gracefully", async () => {
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* already gone */
    }
    const body = await getPositionHistory("200", {});
    assert.strictEqual(body.closeDate, null);
    assert.strictEqual(body.entryValueUsd, null);
    fs.writeFileSync(LOG_PATH, "[]", "utf8");
  });

  it("returns fallback prices when provided", async () => {
    fs.writeFileSync(LOG_PATH, "[]", "utf8");
    const body = await getPositionHistory("888", {
      fallbackPrices: { price0: 1.5, price1: 0.8 },
    });
    assert.strictEqual(body.tokenId, "888");
    assert.strictEqual(body.token0UsdPriceAtOpen, 1.5);
    assert.strictEqual(body.token1UsdPriceAtOpen, 0.8);
  });

  it("returns complete result shape", async () => {
    fs.writeFileSync(LOG_PATH, "[]", "utf8");
    const body = await getPositionHistory("999", {});
    assert.strictEqual(body.tokenId, "999");
    assert.ok("mintDate" in body);
    assert.ok("closeDate" in body);
    assert.ok("entryValueUsd" in body);
    assert.ok("exitValueUsd" in body);
    assert.ok("feesEarnedUsd" in body);
  });
});
