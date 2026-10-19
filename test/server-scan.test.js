/**
 * @file test/server-scan.test.js
 * @description Tests for the LP position scan handlers.
 */

"use strict";

const { describe, it, after } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*-
 *  Token symbols resolved here are fixtures. They go to a file of this
 *  test's own, not the operator's cache, which nothing expires. Set
 *  before src/server-scan.js loads src/token-symbol-cache.js, which
 *  reads it once.
 */
const SYMBOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "server-scan-"));
const SYMBOL_FILE = path.join(SYMBOL_DIR, "token-symbol-cache.json");
process.env.TOKEN_SYMBOL_CACHE_PATH = SYMBOL_FILE;
after(() => fs.rmSync(SYMBOL_DIR, { recursive: true, force: true }));

const {
  createScanHandlers,
  resolveTokenSymbol,
  resolveSymbolMap,
  formatNftResponse,
  poolKey,
} = require("../src/server-scan");
const { getTokenSymbol } = require("../src/token-symbol-cache");

// ── Helpers ─────────────────────────────────────────────────────────

function mockDeps(overrides) {
  return {
    walletManager: {
      getStatus: () => ({
        loaded: true,
        address: "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
      }),
      ...overrides?.walletManager,
    },
    jsonResponse: overrides?.jsonResponse || ((_res, _code, body) => body),
    readJsonBody: overrides?.readJsonBody || (async () => ({})),
    setGlobalScanStatus: overrides?.setGlobalScanStatus || (() => {}),
  };
}

// ── createScanHandlers ──────────────────────────────────────────────

describe("server-scan — createScanHandlers", () => {
  it("returns handler functions", () => {
    const h = createScanHandlers(mockDeps());
    assert.strictEqual(typeof h._handlePositionsScan, "function");
    assert.strictEqual(typeof h._handlePositionsRefresh, "function");
    assert.strictEqual(typeof h.resolveTokenSymbol, "function");
  });
});

// ── _handlePositionsScan — wallet not loaded ────────────────────────

describe("server-scan — scan rejects without wallet", () => {
  it("returns 400 when wallet not loaded", async () => {
    const responses = [];
    const h = createScanHandlers(
      mockDeps({
        walletManager: {
          getStatus: () => ({ loaded: false }),
        },
        jsonResponse: (_res, code, body) => responses.push({ code, body }),
      }),
    );
    await h._handlePositionsScan({}, {});
    assert.strictEqual(responses[0].code, 400);
    assert.strictEqual(responses[0].body.ok, false);
  });
});

// ── _handlePositionsRefresh — no cache ──────────────────────────────

describe("server-scan — refresh with no cache", () => {
  it("returns empty when no cache exists", async () => {
    const responses = [];
    const h = createScanHandlers(
      mockDeps({
        walletManager: {
          getStatus: () => ({
            loaded: true,
            address: "0x0000000000000000000000000000000000000001",
          }),
        },
        jsonResponse: (_res, code, body) => responses.push({ code, body }),
      }),
    );
    // No cache file → returns empty
    await h._handlePositionsRefresh({}, {});
    assert.strictEqual(responses[0].code, 200);
    assert.deepStrictEqual(responses[0].body.poolTicks, {});
    assert.deepStrictEqual(responses[0].body.liquidities, {});
  });
});

// ── _handlePositionsRefresh — wallet not loaded ─────────────────────

describe("server-scan — refresh rejects without wallet", () => {
  it("returns 400 when wallet not loaded", async () => {
    const responses = [];
    const h = createScanHandlers(
      mockDeps({
        walletManager: {
          getStatus: () => ({ loaded: false }),
        },
        jsonResponse: (_res, code, body) => responses.push({ code, body }),
      }),
    );
    await h._handlePositionsRefresh({}, {});
    assert.strictEqual(responses[0].code, 400);
  });
});

// ── resolveTokenSymbol ──────────────────────────────────────────────

describe("server-scan — resolveTokenSymbol", () => {
  it("returns ? for null address", async () => {
    const h = createScanHandlers(mockDeps());
    const sym = await h.resolveTokenSymbol({}, null);
    assert.strictEqual(sym, "?");
  });

  it("returns truncated address on RPC failure", async () => {
    const sym = await resolveTokenSymbol(
      null,
      "0x1234567890abcdef1234567890abcdef12345678",
    );
    assert.ok(sym.includes("0x1234"));
    assert.ok(sym.includes("5678"));
  });
});

// ── resolveSymbolMap ─────────────────────────────────────────────────

describe("server-scan — resolveSymbolMap", () => {
  it("resolves symbols for a set of addresses", async () => {
    const map = await resolveSymbolMap(
      null,
      new Set(["0x1234567890abcdef1234567890abcdef12345678"]),
    );
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    assert.ok(typeof map[addr] === "string");
    assert.ok(map[addr].length > 0);
  });

  it("does not cache the address that stands in for an unreadable name", async () => {
    /*-
     *  With no provider the chain answers nothing, so the list shows the
     *  address. Cached, it would be read back as the token's name by the
     *  next position that asks, and shown in move logs and alerts.
     */
    const addr = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const map = await resolveSymbolMap(null, new Set([addr]));
    assert.match(map[addr], /^0xabcd…abcd$/);
    assert.equal(getTokenSymbol(addr), null);
  });
});

// ── poolKey ─────────────────────────────────────────────────────────

describe("server-scan — poolKey", () => {
  it("builds key from token0, token1, fee", () => {
    const k = poolKey({
      token0: "0xAAA",
      token1: "0xBBB",
      fee: 3000,
    });
    assert.strictEqual(k, "0xAAA-0xBBB-3000");
  });
});

// ── formatNftResponse ───────────────────────────────────────────────

describe("server-scan — formatNftResponse", () => {
  it("formats positions with symbols and ticks", () => {
    const pos = [
      {
        tokenId: 123n,
        token0: "0xA",
        token1: "0xB",
        fee: 3000,
        liquidity: 100n,
      },
    ];
    const sym = { "0xA": "WPLS", "0xB": "DAI" };
    const ticks = { "0xA-0xB-3000": 42 };
    const r = formatNftResponse(pos, sym, ticks);
    assert.strictEqual(r[0].tokenId, "123");
    assert.strictEqual(r[0].liquidity, "100");
    assert.strictEqual(r[0].token0Symbol, "WPLS");
    assert.strictEqual(r[0].poolTick, 42);
  });

  it("uses ? for unknown symbols", () => {
    const pos = [
      {
        tokenId: "1",
        token0: "0xC",
        token1: "0xD",
        fee: 500,
        liquidity: 0n,
      },
    ];
    const r = formatNftResponse(pos, {}, {});
    assert.strictEqual(r[0].token0Symbol, "?");
    assert.strictEqual(r[0].poolTick, null);
  });
});
