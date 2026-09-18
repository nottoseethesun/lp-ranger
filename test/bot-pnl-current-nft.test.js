/**
 * @file test/bot-pnl-current-nft.test.js
 * @description Regression tests for `applyCurrentNftFigures` — the hook
 *   that populates `snap.currentCompoundedUsd` and `snap.currentGasUsd`
 *   for the Managed Current panel.  The panel must agree with what the
 *   Unmanaged on-chain scan reports for the same NFT (see
 *   position-details-compound._scanCompounds).
 *
 *   Three resolution paths are covered:
 *     1. Per-NFT cache hit (gas + compounded both cached) → no scan.
 *     2. Cache miss with compoundHistory entries tagged by tokenId →
 *        compounded derived from history (still no backfill scan needed
 *        for compounded; gas falls back to cache lookup which is missing
 *        and triggers backfill via the injected scan stub).
 *     3. Full miss → backfill scan populates both caches.
 *
 *   Lifetime panel fields (`snap.totalCompoundedUsd`, `snap.totalGas`)
 *   are not exercised here — they remain owned by `bot-pnl-updater`.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const Module = require("module");

/*-
 *  Mock compounder + price-fetcher so the helper module loads without
 *  pulling ethers.Interface (which the bot-hodl-scan tests' partial stub
 *  also avoids by not loading bot-pnl-current-nft transitively).
 */
const _origRequire = Module.prototype.require;
let _detectCalls = [];
let _detectImpl = async () => ({
  compounds: [],
  totalCompoundedUsd: 0,
  totalGasWei: "0",
  totalNftGasWei: "0",
});
function _installMocks() {
  Module.prototype.require = function (id) {
    if (id === "./compounder") {
      return {
        detectCompoundsOnChain: async (tokenId, opts) => {
          _detectCalls.push({ tokenId, opts });
          return _detectImpl(tokenId, opts);
        },
      };
    }
    if (id === "./price-fetcher") {
      return { fetchTokenPriceUsd: async () => 0.00005 }; // wPLS-ish price
    }
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/bot-pnl-current-nft")];
}
function _restoreMocks() {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/bot-pnl-current-nft")];
}

describe("applyCurrentNftFigures — Managed/Unmanaged parity", () => {
  let applyCurrentNftFigures;
  beforeEach(() => {
    _detectCalls = [];
    _installMocks();
    ({ applyCurrentNftFigures } = require("../src/bot-pnl-current-nft"));
  });
  afterEach(_restoreMocks);

  it("uses per-NFT cache when present, no scan", async () => {
    const snap = {};
    /*- The cache holds coins; this poll's prices turn them into the
     *  figure on screen. 4 of token0 at $2 plus 0.39 of token1 at $1. */
    const deps = {
      _botState: {
        nftGasWeiByTokenId: { 12345: "1600000000000000" }, // 0.0016 PLS
        nftCompoundedAmountsByTokenId: { 12345: { amount0: 4, amount1: 0.39 } },
      },
      _lastPrice0: 2,
      _lastPrice1: 1,
    };
    const position = { tokenId: 12345 };
    const poolState = { decimals0: 18, decimals1: 18 };
    await applyCurrentNftFigures(snap, deps, position, poolState);
    assert.strictEqual(snap.currentCompoundedUsd, 8.39);
    assert.ok(snap.currentGasUsd > 0);
    assert.strictEqual(_detectCalls.length, 0, "no backfill scan expected");
  });

  it("derives compounded from compoundHistory when comp cache missing", async () => {
    const snap = {};
    const deps = {
      _botState: {
        /*- Gas is cached, compounded is not — the resolver should fall back
         *  to compoundHistory filtered by tokenId, not trigger a scan. */
        nftGasWeiByTokenId: { 12345: "1000000000000000" },
        /*- Raw amounts, as the scan records them: 5 and 3.39 of token0,
         *  at $1 below. The other NFT's entry must be skipped. */
        compoundHistory: [
          { tokenId: "12345", amount0Deposited: "5", amount1Deposited: "0" },
          { tokenId: "12345", amount0Deposited: "3.39", amount1Deposited: "0" },
          { tokenId: "99999", amount0Deposited: "100", amount1Deposited: "0" },
        ],
      },
      _lastPrice0: 1,
      _lastPrice1: 1,
    };
    const position = { tokenId: 12345 };
    const poolState = { decimals0: 0, decimals1: 0 };
    await applyCurrentNftFigures(snap, deps, position, poolState);
    assert.strictEqual(
      snap.currentCompoundedUsd,
      8.39,
      "should sum only entries matching tokenId",
    );
    assert.strictEqual(_detectCalls.length, 0, "no scan when gas is cached");
  });

  it("triggers backfill scan and persists both caches on full miss", async () => {
    _detectImpl = async () => ({
      /*- Raw deposited amounts, as the classifier returns them: 4 and
       *  4.39 of token0, priced below at $1. */
      compounds: [
        { amount0Deposited: "4", amount1Deposited: "0" },
        { amount0Deposited: "4.39", amount1Deposited: "0" },
      ],
      totalCompoundedUsd: 100, // Lifetime total — not used by Current panel
      totalGasWei: "500000000000000",
      totalNftGasWei: "1600000000000000",
    });
    const updates = [];
    const snap = {};
    const deps = {
      _botState: {},
      signer: { getAddress: async () => "0xWALLET" },
      _lastPrice0: 1,
      _lastPrice1: 1,
      updateBotState: (patch) => updates.push(patch),
    };
    const position = {
      tokenId: 12345,
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
    };
    const poolState = { decimals0: 0, decimals1: 0 };
    await applyCurrentNftFigures(snap, deps, position, poolState);
    assert.strictEqual(_detectCalls.length, 1, "one backfill scan");
    assert.strictEqual(_detectCalls[0].tokenId, "12345");
    assert.strictEqual(snap.currentCompoundedUsd, 8.39);
    assert.ok(snap.currentGasUsd > 0);
    assert.strictEqual(updates.length, 1);
    assert.deepStrictEqual(updates[0].nftGasWeiByTokenId, {
      12345: "1600000000000000",
    });
    /*- Coins are what is saved; the dollars above came from pricing them
     *  at this poll's prices. */
    assert.deepStrictEqual(updates[0].nftCompoundedAmountsByTokenId, {
      12345: { amount0: 8.39, amount1: 0 },
    });
    /*- Caches must also be visible on _botState immediately so subsequent
     *  in-process reads (without waiting for the disk round-trip) see them. */
    assert.deepStrictEqual(deps._botState.nftCompoundedAmountsByTokenId, {
      12345: { amount0: 8.39, amount1: 0 },
    });
  });

  it("returns silently when position has no tokenId", async () => {
    const snap = {};
    await applyCurrentNftFigures(
      snap,
      { _botState: {} },
      {},
      {
        decimals0: 18,
        decimals1: 18,
      },
    );
    assert.strictEqual(snap.currentGasUsd, undefined);
    assert.strictEqual(snap.currentCompoundedUsd, undefined);
    assert.strictEqual(_detectCalls.length, 0);
  });

  it("swallows backfill scan failure (no throw, no snap mutation)", async () => {
    _detectImpl = async () => {
      throw new Error("RPC down");
    };
    const snap = {};
    const deps = {
      _botState: {},
      signer: { getAddress: async () => "0xWALLET" },
    };
    await applyCurrentNftFigures(
      snap,
      deps,
      { tokenId: 12345, token0: "0xA", token1: "0xB", fee: 3000 },
      { decimals0: 18, decimals1: 18 },
    );
    /*- On scan failure _backfill returns { gasWei: '0', compoundedUsd: 0 }.
     *  snap.currentGasUsd is set to 0 (treated as "no gas to display"),
     *  snap.currentCompoundedUsd is 0 (no override). */
    assert.strictEqual(snap.currentGasUsd, 0);
    assert.strictEqual(snap.currentCompoundedUsd, 0);
  });
});
