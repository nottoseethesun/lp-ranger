/**
 * @file test/bot-cycle-compound-record.test.js
 * @description Tests for recordCompound in bot-cycle-compound.js.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

describe("recordCompound", () => {
  let recordCompound;
  const _origRequire = Module.prototype.require;
  let _mockGasCost = 0;

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./bot-pnl-updater") {
        return {
          actualGasCostUsd: async () => _mockGasCost,
          estimateGasCostUsd: async () => 0,
          positionValueUsd: () => 0,
          fetchTokenPrices: async () => ({ price0: 0, price1: 0 }),
        };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/lib/bot-cycle-compound")];
    ({ recordCompound } = require("../src/lib/bot-cycle-compound"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/lib/bot-cycle-compound")];
  });

  it("records compound with gas cost and updates history", async () => {
    _mockGasCost = 1.5;
    const patches = [];
    const deps = {
      updateBotState: (p) => patches.push(p),
      _getConfig: (k) => {
        if (k === "compoundHistory") return [];
        if (k === "compoundedAmount0") return 10;
        if (k === "compoundedAmount1") return 20;
        return undefined;
      },
      _pnlTracker: {
        epochCount: () => 1,
        addGas: () => {},
        serialize: () => ({ closedEpochs: [] }),
      },
    };
    const result = {
      timestamp: "2026-04-01T12:00:00Z",
      depositTxHash: "0xhash",
      amount0Deposited: "1000",
      amount1Deposited: "500",
      depositedAmount0: 2,
      depositedAmount1: 3,
      usdValue: 5.0,
      price0: 0.003,
      price1: 0.001,
      gasCostWei: "100000000000000000",
      trigger: "auto",
    };
    await recordCompound(deps, result);
    // Should have emitted compound history and P&L patches
    const histPatch = patches.find((p) => p.compoundHistory);
    assert.ok(histPatch);
    assert.strictEqual(histPatch.compoundHistory.length, 1);
    assert.strictEqual(histPatch.compoundHistory[0].txHash, "0xhash");
    assert.strictEqual(histPatch.compoundHistory[0].gasCostUsd, 1.5);
    /*- The coins are added, never a dollar total: the saved figure is
     *  priced by whoever shows it. */
    assert.strictEqual(histPatch.compoundedAmount0, 12); // 10 + 2
    assert.strictEqual(histPatch.compoundedAmount1, 23); // 20 + 3
    assert.strictEqual(histPatch.totalCompoundedUsd, undefined);
  });

  it("records the Activity Log figures: the fees collected and their share of the position", async () => {
    /*-
     *  $40 of fees, deposited as $32 of liquidity 100 into an NFT that
     *  held 900: the position after was worth $320, and the fees 12.5%.
     *  The position's liquidity is still the one before the deposit,
     *  since the bot reads it again only after this bookkeeping.
     */
    _mockGasCost = 0;
    const record = async (liquidityBefore) => {
      const patches = [];
      await recordCompound(
        {
          position: { tokenId: 7, liquidity: liquidityBefore },
          updateBotState: (p) => patches.push(p),
          _getConfig: () => undefined,
        },
        {
          timestamp: "2026-04-01T12:00:00Z",
          depositTxHash: "0xhash",
          depositedAmount0: 8,
          depositedAmount1: 16,
          usdValue: 32,
          collectedUsd: 40,
          price0: 2,
          price1: 1,
          feesCollected: { amount0: 10, amount1: 20 },
          liquidity: "100",
          gasCostWei: "0",
          trigger: "auto",
        },
      );
      return patches.find((p) => p.compoundHistory).compoundHistory[0];
    };
    const entry = await record("900");
    assert.deepStrictEqual(entry.feesCollected, { amount0: 10, amount1: 20 });
    assert.ok(
      Math.abs(entry.historical.percentGainForPosition - 12.5) < 1e-9,
      JSON.stringify(entry.historical),
    );
    assert.strictEqual(entry.trigger, "auto");
    /*-
     *  The prices its $usd amount was worked out at stay on the record,
     *  which is what marks the amount "(historical $usd)" in the log.
     */
    assert.strictEqual(entry.usdValue, 32);
    assert.strictEqual(entry.price0, 2);
    assert.strictEqual(entry.price1, 1);
    // A liquidity it cannot read still records the compound, figure unknown.
    const unread = await record("not a number");
    assert.strictEqual(unread.txHash, "0xhash");
    assert.deepStrictEqual(unread.historical, { percentGainForPosition: null });
  });

  it("drops this NFT's cached Current-panel figures so the next poll rescans", async () => {
    /*-
     *  The Current panel reads `nftCompoundedAmountsByTokenId[tokenId]`
     *  and `nftGasWeiByTokenId[tokenId]`. A compound just changed both,
     *  and neither is recomputed here — `applyCurrentNftFigures` refills
     *  them, but only on a cache MISS. Left in place, the panel keeps
     *  showing the pre-compound figure until a rebalance or a Reload.
     *
     *  Other NFTs in the chain are untouched: their figures are still
     *  correct, and dropping them would buy a per-NFT rescan for nothing.
     */
    _mockGasCost = 0;
    const patches = [];
    const deps = {
      position: { tokenId: 12345 },
      updateBotState: (p) => patches.push(p),
      _getConfig: (k) => {
        if (k === "nftGasWeiByTokenId") return { 12345: "999", 999: "keep-me" };
        if (k === "nftCompoundedAmountsByTokenId")
          return {
            12345: { amount0: 1, amount1: 1 },
            999: { amount0: 7, amount1: 7 },
          };
        return undefined;
      },
    };
    await recordCompound(deps, {
      timestamp: "2026-04-01T12:00:00Z",
      depositedAmount0: 2,
      depositedAmount1: 3,
      usdValue: 5,
      gasCostWei: "0",
      trigger: "auto",
    });
    const patch = patches.find((p) => p.nftCompoundedAmountsByTokenId);
    assert.ok(patch, "a patch carrying the per-NFT maps must be emitted");
    assert.strictEqual(
      patch.nftCompoundedAmountsByTokenId["12345"],
      undefined,
      "the compounded NFT's coins must be dropped",
    );
    assert.strictEqual(
      patch.nftGasWeiByTokenId["12345"],
      undefined,
      "the compounded NFT's gas must be dropped",
    );
    assert.deepStrictEqual(
      patch.nftCompoundedAmountsByTokenId["999"],
      { amount0: 7, amount1: 7 },
      "another NFT's coins must survive",
    );
    assert.strictEqual(patch.nftGasWeiByTokenId["999"], "keep-me");
  });

  it("handles zero gas cost", async () => {
    _mockGasCost = 0;
    const patches = [];
    const deps = {
      updateBotState: (p) => patches.push(p),
      _getConfig: () => undefined,
    };
    const result = {
      timestamp: "2026-04-01T12:00:00Z",
      usdValue: 2.0,
      gasCostWei: "0",
      trigger: "manual",
    };
    await recordCompound(deps, result);
    const histPatch = patches.find((p) => p.compoundHistory);
    assert.ok(histPatch);
    assert.strictEqual(histPatch.compoundHistory[0].gasCostUsd, 0);
  });

  it("adds gas to P&L tracker when tracker has epochs", async () => {
    _mockGasCost = 0.5;
    let gasAdded = false;
    const deps = {
      updateBotState: () => {},
      _getConfig: () => undefined,
      _pnlTracker: {
        epochCount: () => 2,
        addGas: () => (gasAdded = true),
        serialize: () => ({}),
      },
    };
    await recordCompound(deps, {
      usdValue: 1,
      gasCostWei: "50000000000000000",
      trigger: "auto",
    });
    assert.ok(gasAdded);
  });

  it("skips P&L tracker gas when no epochs", async () => {
    _mockGasCost = 0.5;
    let gasAdded = false;
    const deps = {
      updateBotState: () => {},
      _getConfig: () => undefined,
      _pnlTracker: {
        epochCount: () => 0,
        addGas: () => (gasAdded = true),
        serialize: () => ({}),
      },
    };
    await recordCompound(deps, {
      usdValue: 1,
      gasCostWei: "50000000000000000",
      trigger: "auto",
    });
    assert.ok(!gasAdded);
  });

  /*-
   *  The worked example the user was given: a deposit of 100 A + 100 B
   *  waits in the wallet, a compound collects 10 + 10 of fees, and its
   *  swap's deposit takes all 110 + 110. Fees Compounded must grow by
   *  the fees alone: the deposit is money put in, and counting it as
   *  fees would raise Fees Compounded by $200 and read in the Lifetime
   *  IL/G as a loss of $200.
   */
  const swept = {
    timestamp: "2026-10-23T12:00:00Z",
    depositTxHash: "0xswept",
    amount0Deposited: "110",
    amount1Deposited: "110",
    depositedAmount0: 110,
    depositedAmount1: 110,
    amount0Compounded: "10",
    amount1Compounded: "10",
    feesCompounded: { amount0: 10, amount1: 10 },
    usdValue: 220,
    price0: 1,
    price1: 1,
    gasCostWei: "0",
    trigger: "auto",
  };

  /** Record `result` against a saved total of 5 + 5 coins. */
  async function recordAgainstTotal(result) {
    _mockGasCost = 0;
    const patches = [];
    await recordCompound(
      {
        position: { tokenId: 7 },
        updateBotState: (p) => patches.push(p),
        _getConfig: (k) => {
          if (k === "compoundedAmount0") return 5;
          if (k === "compoundedAmount1") return 5;
          return undefined;
        },
      },
      result,
    );
    return patches.find((p) => p.compoundHistory);
  }

  it("adds only the fees the deposit put back to the running total", async () => {
    const patch = await recordAgainstTotal(swept);
    assert.strictEqual(patch.compoundedAmount0, 15); // 5 + 10, not 5 + 110
    assert.strictEqual(patch.compoundedAmount1, 15);
  });

  it("keeps the fees on the compound's record beside the whole deposit", async () => {
    const entry = (await recordAgainstTotal(swept)).compoundHistory[0];
    assert.strictEqual(entry.amount0Deposited, "110");
    assert.strictEqual(entry.amount0Compounded, "10");
    assert.strictEqual(entry.amount1Compounded, "10");
  });

  it("keeps the fees the deposit left in the wallet on the compound's record", async () => {
    const left = { ...swept, amount0FeesLeft: "2", amount1FeesLeft: "0" };
    const patch = await recordAgainstTotal(left);
    const entry = patch.compoundHistory[0];
    assert.strictEqual(entry.amount0FeesLeft, "2");
    assert.strictEqual(entry.amount1FeesLeft, "0");
    // The running total stays the fees put back.
    assert.strictEqual(patch.compoundedAmount0, 15);
    const none = (await recordAgainstTotal(swept)).compoundHistory[0];
    assert.strictEqual("amount0FeesLeft" in none, false);
  });

  it("keeps the deposit's block and the wallet's coins before the collect on the compound's record", async () => {
    /*- A deposit to the wallet still waiting there is taken by the
     *  compound in proportion to its share of that balance
     *  (src/lib/deposit-attribution.js). */
    const read = {
      ...swept,
      depositBlock: 1234,
      amount0WalletBefore: "500",
      amount1WalletBefore: "0",
    };
    const entry = (await recordAgainstTotal(read)).compoundHistory[0];
    assert.strictEqual(entry.blockNumber, 1234);
    assert.strictEqual(entry.amount0WalletBefore, "500");
    assert.strictEqual(entry.amount1WalletBefore, "0");
    const none = (await recordAgainstTotal(swept)).compoundHistory[0];
    assert.strictEqual("blockNumber" in none, false);
    assert.strictEqual("amount0WalletBefore" in none, false);
  });

  it("adds and records the whole deposit for a result without the readings", async () => {
    const old = { ...swept };
    delete old.amount0Compounded;
    delete old.amount1Compounded;
    delete old.feesCompounded;
    const patch = await recordAgainstTotal(old);
    assert.strictEqual(patch.compoundedAmount0, 115);
    assert.strictEqual(patch.compoundHistory[0].amount0Compounded, undefined);
  });
});

describe("the compound's Telegram message", () => {
  let _compoundMessage;
  before(() => {
    ({ _compoundMessage } = require("../src/lib/bot-cycle-compound"));
  });
  const base = {
    amount0Deposited: "110",
    amount1Deposited: "110",
    depositedAmount0: 110,
    depositedAmount1: 110,
    usdValue: 220,
    price0: 1,
    price1: 1,
  };

  it("names the fees, and the wallet's coins the deposit took in", () => {
    const message = _compoundMessage({
      ...base,
      amount0Compounded: "10",
      amount1Compounded: "10",
      feesCompounded: { amount0: 10, amount1: 10 },
    });
    assert.strictEqual(
      message,
      "Compounded $20.00 in fees, and put $200.00 of coins the wallet already held into the position",
    );
  });

  it("names the fees alone when the deposit took only fees", () => {
    const message = _compoundMessage({
      ...base,
      amount0Compounded: "110",
      amount1Compounded: "110",
      feesCompounded: { amount0: 110, amount1: 110 },
    });
    assert.strictEqual(message, "Compounded $220.00 in fees");
  });

  it("counts the whole deposit as fees without the readings, as before", () => {
    assert.strictEqual(_compoundMessage(base), "Compounded $220.00 in fees");
  });
});
