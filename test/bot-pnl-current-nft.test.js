/**
 * @file test/bot-pnl-current-nft.test.js
 * @description Regression tests for `applyCurrentNftFigures` — the hook
 *   that populates `snap.currentCompoundedUsd` and `snap.currentGasUsd`
 *   for the Managed Current panel.  The panel must agree with what the
 *   Unmanaged on-chain scan reports for the same NFT (see
 *   position-details-compound._detectCurrentNftValues).
 *
 *   Three resolution paths are covered:
 *     1. Per-NFT cache hit (gas + compounded both cached) → no scan.
 *     2. Cache miss with compoundHistory entries tagged by tokenId →
 *        compounded derived from history (still no chain scan needed
 *        for compounded; gas falls back to cache lookup which is missing
 *        and triggers a scan via the injected stub).
 *     3. Full miss → a chain scan populates both caches.
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
    assert.strictEqual(_detectCalls.length, 0, "no chain scan expected");
    assert.strictEqual(snap.currentFeesLeftUsd, 0, "no compound left any");
  });

  it("publishes the fees this NFT's compounds left in the wallet, at this poll's prices", async () => {
    /*-
     *  Fees Compounded stays the coins put back, which the Current IL/G
     *  takes off the position's side; the fees left wait in the wallet,
     *  earned by this NFT. 2 of token0 at $2 and 3 of token1 at $1, from
     *  this NFT's compounds only, at decimals 18 and 6.
     */
    const snap = {};
    const deps = {
      _botState: {
        nftGasWeiByTokenId: { 12345: "1000000000000000" },
        nftCompoundedAmountsByTokenId: { 12345: { amount0: 4, amount1: 0 } },
        compoundHistory: [
          {
            tokenId: "12345",
            amount0FeesLeft: "1500000000000000000",
            amount1FeesLeft: "3000000",
          },
          {
            tokenId: "12345",
            amount0FeesLeft: "500000000000000000",
            amount1FeesLeft: "0",
          },
          { tokenId: "999", amount0FeesLeft: "9", amount1FeesLeft: "9" },
        ],
      },
      _lastPrice0: 2,
      _lastPrice1: 1,
    };
    await applyCurrentNftFigures(
      snap,
      deps,
      { tokenId: 12345 },
      { decimals0: 18, decimals1: 6 },
    );
    assert.strictEqual(snap.currentFeesLeftUsd, 7);
    assert.strictEqual(snap.currentCompoundedUsd, 8, "the coins put back");
  });

  it("derives compounded from compoundHistory when comp cache missing", async () => {
    const snap = {};
    const deps = {
      _botState: {
        /*- Gas is cached, compounded is not — the resolver should fall back
         *  to compoundHistory filtered by tokenId, not trigger a scan. */
        nftGasWeiByTokenId: { 12345: "1000000000000000" },
        /*-
         *  RAW units, as the scan records them, at the pool's real
         *  decimals — 18 for token0, 6 for token1, deliberately unequal.
         *  Equal decimals, or decimals of 0, would let an implementation
         *  that never divided produce the right answer anyway.
         *
         *  5 + 3.39 of token0 at $1, and 2 of token1 at $3: 14.39.
         *  The other NFT's entry must be skipped.
         */
        compoundHistory: [
          {
            tokenId: "12345",
            amount0Deposited: "5000000000000000000",
            amount1Deposited: "0",
          },
          {
            tokenId: "12345",
            amount0Deposited: "3390000000000000000",
            amount1Deposited: "2000000",
          },
          {
            tokenId: "99999",
            amount0Deposited: "100000000000000000000",
            amount1Deposited: "0",
          },
        ],
      },
      _lastPrice0: 1,
      _lastPrice1: 3,
    };
    const position = { tokenId: 12345 };
    const poolState = { decimals0: 18, decimals1: 6 };
    await applyCurrentNftFigures(snap, deps, position, poolState);
    assert.strictEqual(
      snap.currentCompoundedUsd,
      14.39,
      "sums only this NFT's entries, scaled by each token's own decimals",
    );
    assert.strictEqual(_detectCalls.length, 0, "no scan when gas is cached");
  });

  /*-
   *  The case the user reported: a deposit of 100 + 100 waited in the
   *  wallet when a compound collected 10 + 10 of fees, and its swap's
   *  deposit took all 110 + 110. The NFT's Fees Compounded is taken off
   *  the position's side of the Current IL/G and the Guard, so counting
   *  the deposit there reads as a $200 loss.
   */
  const sweptRecord = {
    txHash: "0xAB",
    tokenId: "12345",
    trigger: "auto",
    amount0Deposited: "110000000000000000000",
    amount1Deposited: "110000000",
    amount0Compounded: "10000000000000000000",
    amount1Compounded: "10000000",
  };

  it("counts the fees a compound's record names, from compoundHistory", async () => {
    const snap = {};
    const deps = {
      _botState: {
        nftGasWeiByTokenId: { 12345: "1" },
        compoundHistory: [sweptRecord],
      },
      _lastPrice0: 1,
      _lastPrice1: 1,
    };
    const poolState = { decimals0: 18, decimals1: 6 };
    await applyCurrentNftFigures(snap, deps, { tokenId: 12345 }, poolState);
    assert.strictEqual(snap.currentCompoundedUsd, 20);
  });

  it("counts the fees a compound's record names, from the chain", async () => {
    /*-
     *  The chain shows the whole deposit. The record of the compound the
     *  bot made, matched by transaction whatever the case of its hash,
     *  names the fees; a compound it did not record counts its whole
     *  deposit.
     */
    _detectImpl = async () => ({
      compounds: [
        {
          txHash: "0xab",
          amount0Deposited: "110000000000000000000",
          amount1Deposited: "110000000",
        },
        {
          txHash: "0xcd",
          amount0Deposited: "1000000000000000000",
          amount1Deposited: "0",
        },
      ],
      totalCompoundedUsd: 0,
      totalGasWei: "0",
      totalNftGasWei: "1",
    });
    const updates = [];
    const snap = {};
    const deps = {
      _botState: { compoundHistory: [sweptRecord] },
      signer: { getAddress: async () => "0xWALLET" },
      _lastPrice0: 1,
      _lastPrice1: 1,
      updateBotState: (patch) => updates.push(patch),
    };
    const position = { tokenId: 12345, token0: "0xA", token1: "0xB" };
    const poolState = { decimals0: 18, decimals1: 6 };
    await applyCurrentNftFigures(snap, deps, position, poolState);
    assert.deepStrictEqual(updates[0].nftCompoundedAmountsByTokenId, {
      12345: { amount0: 11, amount1: 10 },
    });
    assert.strictEqual(snap.currentCompoundedUsd, 21);
  });

  it("triggers a chain scan and persists both caches on full miss", async () => {
    _detectImpl = async () => ({
      /*- RAW deposited amounts, as the classifier returns them, at the
       *  pool's real and unequal decimals: 4 + 4.39 of token0 (18dp) and
       *  2 of token1 (6dp). Priced below at $1 and $3 → 8.39 + 6. */
      compounds: [
        { amount0Deposited: "4000000000000000000", amount1Deposited: "0" },
        {
          amount0Deposited: "4390000000000000000",
          amount1Deposited: "2000000",
        },
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
      _lastPrice1: 3,
      updateBotState: (patch) => updates.push(patch),
    };
    const position = {
      tokenId: 12345,
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
    };
    const poolState = { decimals0: 18, decimals1: 6 };
    await applyCurrentNftFigures(snap, deps, position, poolState);
    assert.strictEqual(_detectCalls.length, 1, "one chain scan");
    assert.strictEqual(_detectCalls[0].tokenId, "12345");
    assert.strictEqual(snap.currentCompoundedUsd, 14.39);
    assert.ok(snap.currentGasUsd > 0);
    assert.strictEqual(updates.length, 1);
    assert.deepStrictEqual(updates[0].nftGasWeiByTokenId, {
      12345: "1600000000000000",
    });
    /*- Coins are what is saved — each token scaled by its OWN decimals;
     *  the dollars above came from pricing them at this poll's prices. */
    assert.deepStrictEqual(updates[0].nftCompoundedAmountsByTokenId, {
      12345: { amount0: 8.39, amount1: 2 },
    });
    /*- Caches must also be visible on _botState immediately so subsequent
     *  in-process reads (without waiting for the disk round-trip) see them. */
    assert.deepStrictEqual(deps._botState.nftCompoundedAmountsByTokenId, {
      12345: { amount0: 8.39, amount1: 2 },
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

  it("swallows a chain-scan failure (no throw, no snap mutation)", async () => {
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
    /*- A failed scan leaves the gas UNKNOWN, and this case's own name says
     *  so: no snap mutation. It previously asserted a mutation to zero,
     *  which told the dashboard the NFT had cost nothing to run — and
     *  zero is indistinguishable from a real figure, so the operator had
     *  no way to tell the scan had failed.
     *
     *  Absent is what the dashboard already expects: it falls back to the
     *  running epoch's gas when this field is missing. Compounded stays
     *  zero because a failed scan read no events to sum. */
    assert.strictEqual(
      snap.currentGasUsd,
      undefined,
      "a failed scan must leave the gas figure absent, not zero",
    );
    assert.strictEqual(snap.currentCompoundedUsd, 0);
  });
});

describe("applyCurrentNftFigures — where the NFT's history read starts", () => {
  let applyCurrentNftFigures;
  beforeEach(() => {
    _detectCalls = [];
    _installMocks();
    ({ applyCurrentNftFigures } = require("../src/bot-pnl-current-nft"));
  });
  afterEach(_restoreMocks);

  /** Run one Current-panel read with nothing cached, over `events`. */
  async function readOver(events) {
    await applyCurrentNftFigures(
      {},
      {
        _botState: {},
        _rebalanceEvents: events,
        signer: { getAddress: async () => "0xWALLET" },
      },
      { tokenId: 12345, token0: "0xA", token1: "0xB", fee: 3000 },
      { decimals0: 18, decimals1: 18 },
    );
    assert.strictEqual(_detectCalls.length, 1, "one chain read");
    return _detectCalls[0].opts.fromBlock;
  }

  it("starts at the mint block the bot recorded for an NFT it minted", async () => {
    /*-
     *  After every compound this read runs again, inside the position's
     *  check. From the mint it covers the NFT's own life; from anywhere
     *  earlier it reads blocks the NFT cannot appear in.
     */
    const from = await readOver([
      { oldTokenId: "12344", newTokenId: "12345", blockNumber: 27_700_123 },
    ]);
    assert.strictEqual(from, 27_700_123);
  });

  it("does not start at block 0 where an older record names it", async () => {
    /*-
     *  Records the bot wrote before it kept the mint block say block 0.
     *  Started there, the read covers the whole chain, about half an
     *  hour in which the position is not checked. The chain's first mint
     *  is the floor instead, as for any NFT whose mint is not known.
     */
    const events = [
      { oldTokenId: "12344", newTokenId: "12345", blockNumber: 0 },
    ];
    events.firstMintBlockNumber = 27_000_000;
    const from = await readOver(events);
    assert.strictEqual(from, 27_000_000);
  });
});
