/**
 * @file test/mint-gas-prices-by-block.test.js
 * @description
 * The mint gas lookup must carry the mint's BLOCK, not only its date.
 *
 * Moralis prices by block and is the only historical source that can
 * answer for an old NFT — GeckoTerminal's public OHLCV refuses anything
 * past 180 days with a 401. `fetchHistoricalTokenPriceUsd` asks Moralis
 * only when it is handed a block number, so a `when` carrying the
 * timestamp alone skips the one source that could have answered and
 * lands on today's price instead. Nothing fails loudly when it does: the
 * charge still appears, at the wrong valuation.
 *
 * Driven through `_applyMintGas` and observed at the outgoing HTTP
 * request, so it is the real path rather than a restatement of it — see
 * CLAUDE-TESTING.md § No Mirroring.
 */

"use strict";

const path = require("path");
const fs = require("fs");

/*- CRITICAL: redirect both disk caches BEFORE requiring anything that
 *  reads them. A historical price is cached by day and flushed to disk,
 *  so without this the first run caches the answer and every later run
 *  is served from the cache — no HTTP request, and a test that passes
 *  once then fails forever after. Neither `wipe-settings` nor
 *  `dev-clean` clears these: they are deliberately kept because they
 *  cost API quota. */
process.env.PRICE_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  `test-mint-gas-price-cache-${process.pid}.json`,
);
process.env.GECKO_POOL_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  `test-mint-gas-pool-cache-${process.pid}.json`,
);

const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");

const holder = require("../src/api-key-holder");
const { _applyMintGas } = require("../src/bot-pnl-updater");
const { createPnlTracker } = require("../src/pnl-tracker");
const {
  _resetForTest: _resetPriceCache,
  _CACHE_PATH,
} = require("../src/price-cache");
const { _CACHE_PATH: _POOL_CACHE_PATH } = require("../src/gecko-pool-cache");

const MINT_BLOCK = 20686675;
const MINT_TS = 1718948855; // 2024-06-21, well past the 180-day wall.

let _origFetch;
let _origKey;
let _origEnabled;

/** A tracker with one open epoch, ready to receive the charge. */
function _tracker() {
  const t = createPnlTracker();
  t.openEpoch({
    entryValue: 1000,
    entryPrice: 0.001,
    lowerPrice: 0.0005,
    upperPrice: 0.002,
  });
  return t;
}

/** Remove a scratch cache file, if it was written. */
function _unlink(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* never written */
  }
}

describe("mint gas is priced by block, not by date alone", () => {
  after(() => {
    _unlink(_CACHE_PATH);
    _unlink(_POOL_CACHE_PATH);
  });

  beforeEach(() => {
    _origFetch = globalThis.fetch;
    _origKey = holder.getApiKey("moralis");
    _origEnabled = holder.isServiceEnabled("moralis");
    holder.setApiKey("moralis", "TESTKEY");
    holder.setServiceEnabled("moralis", true);
    _resetPriceCache();
    _unlink(_CACHE_PATH);
  });

  afterEach(() => {
    globalThis.fetch = _origFetch;
    holder.setApiKey("moralis", _origKey);
    holder.setServiceEnabled("moralis", _origEnabled);
    _resetPriceCache();
    _unlink(_CACHE_PATH);
  });

  it("sends the stored mint block to Moralis as to_block", async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ usdPrice: 0.00002 }),
      };
    };

    const deps = {
      _botState: {
        hodlBaseline: {
          mintGasWei: "1401849083736715923688",
          mintTimestamp: MINT_TS,
          mintBlockNumber: MINT_BLOCK,
        },
      },
    };
    const tracker = _tracker();
    await _applyMintGas(deps, tracker);

    const moralis = urls.filter((u) => u.includes("deep-index.moralis.io"));
    assert.ok(
      moralis.length > 0,
      `Moralis was never asked — requests were:\n  ${urls.join("\n  ") || "(none)"}`,
    );
    assert.ok(
      moralis.some((u) => u.includes(`to_block=${MINT_BLOCK}`)),
      `no request carried the mint block. Moralis URLs:\n  ${moralis.join("\n  ")}`,
    );
    assert.ok(
      tracker.snapshot(0.001).totalGas > 0,
      "the charge still lands on the epoch",
    );
  });

  it("still charges the gas when no block was stored", async () => {
    /*- A baseline written before the block was kept. The charge must not
     *  vanish — a positive wei amount costing $0 reads downstream as
     *  "price unknown" and drops the whole period from the Per-Day
     *  table. Today's price is the deliberate fallback. */
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pairs: [
          {
            priceUsd: "0.00001",
            chainId: "pulsechain",
            liquidity: { usd: 1000 },
          },
        ],
      }),
    });
    const deps = {
      _botState: {
        hodlBaseline: {
          mintGasWei: "15000000000000000",
          mintTimestamp: MINT_TS,
        },
      },
    };
    const tracker = _tracker();
    await _applyMintGas(deps, tracker);
    assert.ok(
      tracker.snapshot(0.001).totalGas > 0,
      "gas is still charged without a block",
    );
  });
});
