/**
 * @file test/bot-recorder-lifetime-figures.test.js
 * @description Tests for how the lifetime scan in
 * `src/bot-recorder-lifetime.js` treats its saved figures. It skips its
 * read only when all three are saved. A read that computes a missing
 * figure starts from the pool's creation block.
 *
 * One read of the chain feeds three figures — lifetime HODL, Fees
 * Compounded, Lifetime Deposit — each saved on its own. A missing figure
 * is computed from scratch. A read that covered only part of the chain
 * would sum that part as if it were the whole.
 *
 * The share test (`bot-recorder-lifetime-share.test.js`) pins where every
 * read starts, for every combination of saved figures. The mock harness
 * is shared via `test/helpers/`, not copied.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  state,
  resetState,
  installMocks,
  restoreMocks,
  makePosition,
  makeBotState,
} = require("./helpers/bot-recorder-lifetime-mocks");

describe("lifetimeFiguresSaved", () => {
  let lifetimeFiguresSaved;

  beforeEach(() => {
    installMocks();
    ({ lifetimeFiguresSaved } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  /** Every figure saved, then `changes` applied. */
  const figures = (changes) => ({
    cachedHodl: { poolAddress: "0xPOOL" },
    hasCompoundData: true,
    hasDepositData: true,
    ...changes,
  });

  it("is true only when all three lifetime figures are saved", () => {
    const disk = figures({});
    const saved = lifetimeFiguresSaved(disk);
    assert.equal(saved, true);
  });

  it("is false when the compound total is missing", () => {
    const disk = figures({ hasCompoundData: false });
    const saved = lifetimeFiguresSaved(disk);
    assert.equal(saved, false);
  });

  it("is false when the deposit total is missing", () => {
    const disk = figures({ hasDepositData: false });
    const saved = lifetimeFiguresSaved(disk);
    assert.equal(saved, false);
  });

  it("is false when the cached HODL is missing", () => {
    const disk = figures({ cachedHodl: null });
    const saved = lifetimeFiguresSaved(disk);
    assert.equal(saved, false);
  });

  it("is false for an empty state", () => {
    const saved = lifetimeFiguresSaved({});
    assert.equal(saved, false);
  });
});

describe("_scanLifetimePoolData — one figure missing", () => {
  let _scanLifetimePoolData;

  beforeEach(() => {
    resetState();
    // Not zero, so an assertion shows the read was given this block.
    state.poolCreationBlock = 100;
    installMocks();
    ({ _scanLifetimePoolData } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  /** One lifetime scan with `configValues` saved in the position's slot. */
  const _run = (configValues) => {
    const position = makePosition();
    const botState = makeBotState(configValues);
    return _scanLifetimePoolData(
      position,
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
  };

  it("computes the compound total from a read of the whole chain", async () => {
    // HODL and deposit saved, compounds not.
    await _run({ totalLifetimeDepositUsd: 1704.15 });
    assert.equal(state.classifyCalled, true, "compounds must be classified");
    assert.equal(state.depositCalled, false, "the saved deposit is kept");
    assert.equal(state.scanFromBlock, 100, "read from pool creation");
  });

  it("recomputes only the deposit total when it alone is missing", async () => {
    await _run({ compoundedAmount0: 12.5, compoundedAmount1: 40 });
    assert.equal(state.depositCalled, true, "deposit must be recomputed");
    assert.equal(state.classifyCalled, false, "the saved compounds are kept");
    assert.equal(state.scanFromBlock, 100, "read from pool creation");
  });

  it("keeps the saved HODL amounts when no rebalance forced the scan", async () => {
    await _run({ totalLifetimeDepositUsd: 1704.15 });
    assert.equal(state.hodlComputed, false, "the cached amounts stand");
  });
});

describe("_mintBlockOf", () => {
  let _mintBlockOf;

  beforeEach(() => {
    installMocks();
    ({ _mintBlockOf } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  /** A read carrying one NFT whose mint is its first IncreaseLiquidity. */
  const read = () =>
    new Map([
      [
        "7",
        {
          ilEvents: [{ blockNumber: 500 }, { blockNumber: 900 }],
          collectEvents: [],
          dlEvents: [],
        },
      ],
    ]);

  it("takes the mint from the first IncreaseLiquidity", () => {
    /*- The baseline is priced at this block. The later event is a
     *  compound, and pricing the mint there would value the deposit on
     *  the wrong day. */
    assert.equal(_mintBlockOf(read(), "7"), 500);
  });

  it("accepts a numeric tokenId, since the read is keyed by string", () => {
    assert.equal(_mintBlockOf(read(), 7), 500);
  });

  it("returns nothing for an NFT the read does not carry", () => {
    /*- The caller then prices by date instead of by block, rather than
     *  throwing in the middle of a scan. */
    assert.equal(_mintBlockOf(read(), "8"), undefined);
    assert.equal(_mintBlockOf(new Map(), "7"), undefined);
  });
});

describe("_classifyAllCompounds — the per-NFT figure", () => {
  let _classifyAllCompounds;

  beforeEach(() => {
    resetState();
    installMocks();
    ({ _classifyAllCompounds } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  it("publishes each NFT's own compounded total from the same prices", async () => {
    /*-
     *  The Current panel reads the per-NFT figure. Left out, the next
     *  poll rebuilds it by scanning that NFT again, at whatever prices
     *  hold then — so the panel and the Lifetime total could disagree
     *  after a re-value.
     */
    /*- `usdValue` comes attached by the real `classifyCompounds`, which
     *  prices each event from the same options the scan passes it. */
    state.compoundResult = {
      compounds: [
        {
          amount0Deposited: "1000000000000000000",
          amount1Deposited: "0",
          usdValue: 2,
          timestamp: 1,
          txHash: "0xc1",
        },
      ],
      totalCompoundedUsd: 7,
      feeAmount0: 3,
      feeAmount1: 4,
      totalGasWei: "0",
      totalNftGasWei: "0",
    };
    const patches = [];
    await _classifyAllCompounds(
      new Set(["1"]),
      new Map([["1", { ilEvents: [], collectEvents: [], dlEvents: [] }]]),
      { decimals0: 18, decimals1: 18, price0: 2, price1: 1 },
      (p) => patches.push(p),
      null,
    );
    const patch = patches.find((p) => p.compoundedAmount0 !== undefined);
    assert.equal(patch.compoundedAmount0, 3, "the lifetime coins, not dollars");
    assert.equal(patch.compoundedAmount1, 4);
    assert.deepEqual(
      patch.nftCompoundedAmountsByTokenId,
      { 1: { amount0: 1, amount1: 0 } },
      "one token0 compounded against this NFT",
    );
  });

  it("refuses to classify against invalid decimals, and saves nothing", async () => {
    /*-
     *  Every amount below is raw units divided by `10 ** decimals`, so a
     *  wrong exponent is a money figure wrong by orders of magnitude —
     *  saved to disk and priced on screen looking entirely ordinary.
     *  Defaulting the exponent cannot be right except by luck, so the
     *  scan fails instead and the operator gets a log line.
     *
     *  `_ensureTokenDecimals` should have stopped the scan long before
     *  here; this is the backstop for that guarantee breaking.
     */
    const patches = [];
    for (const bad of [undefined, null, NaN, -1, 78, "18"]) {
      await assert.rejects(
        () =>
          _classifyAllCompounds(
            new Set(["1"]),
            new Map([["1", { ilEvents: [], collectEvents: [], dlEvents: [] }]]),
            { decimals0: bad, decimals1: 18, price0: 1, price1: 1 },
            (p) => patches.push(p),
            null,
          ),
        /decimals are invalid/,
        `decimals0=${String(bad)} must be refused`,
      );
    }
    assert.equal(patches.length, 0, "nothing may be written");
  });
});

describe("_recordScanSuccess — which requests a scan answers", () => {
  let _recordScanSuccess;

  beforeEach(() => {
    resetState();
    installMocks();
    ({ _recordScanSuccess } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  const ctx = { t0Sym: "A", t1Sym: "B", tokenIdStr: "1", tokenEmoji: "" };
  /** A state carrying both requests, mid-scan. */
  const both = () => ({
    totalLifetimeDepositUsd: 1704.15,
    _needsFullRescan: true,
    _needsPriceRevalue: true,
  });

  it("answers only the request it carried in", () => {
    /*-
     *  A rebalance can land while a scan is running — "Rebalance Now"
     *  is not gated on it. That rebalance's new NFT is not in the chain
     *  this scan read, so clearing its request here would drop the work
     *  with nothing left to say it is owed.
     */
    const state = both();
    _recordScanSuccess(state, () => {}, ctx, { revalue: true });
    assert.equal(state._needsPriceRevalue, false, "this scan's request");
    assert.equal(state._needsFullRescan, true, "the rebalance's, kept");
  });

  it("publishes only the cleared request", () => {
    const patches = [];
    _recordScanSuccess(both(), (p) => patches.push(p), ctx, {
      fullRescan: true,
    });
    const [patch] = patches;
    assert.equal(patch._needsFullRescan, false);
    assert.equal(patch._needsPriceRevalue, undefined);
  });

  it("still records readiness when it carried no request", () => {
    const state = both();
    _recordScanSuccess(state, () => {}, ctx, {});
    assert.equal(state.lifetimeScanComplete, true);
    assert.equal(state._needsFullRescan, true);
    assert.equal(state._needsPriceRevalue, true);
  });
});

describe("_scanLifetimePoolData — after a rebalance", () => {
  let _scanLifetimePoolData;

  beforeEach(() => {
    resetState();
    state.poolCreationBlock = 100;
    installMocks();
    ({ _scanLifetimePoolData } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  /** Every figure saved, and a rebalance has just fired. */
  const _run = async () => {
    const botState = makeBotState({
      compoundedAmount0: 12.5,
      compoundedAmount1: 40,
      totalLifetimeDepositUsd: 1704.15,
    });
    botState._needsFullRescan = true;
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    return botState;
  };

  it("re-derives the lifetime HODL, since the mint took the wallet balance", async () => {
    /*-
     *  A rebalance mints with everything in the wallet, so coins that
     *  arrived since the previous mint are deposits in the new NFT. Only
     *  this step finds them, and the deposit total is built from what it
     *  finds.
     */
    await _run();
    assert.equal(state.hodlComputed, true, "the HODL must be re-derived");
    assert.equal(state.depositCalled, true, "the deposit total follows it");
  });

  it("keeps the saved compound total, which the rebalance already credited", async () => {
    /*-
     *  `_bumpRebalanceFees` credits the fees that rebalance re-deposited
     *  before this scan runs, so re-classifying the chain would only
     *  recompute a figure that is already right.
     */
    await _run();
    assert.equal(state.classifyCalled, false);
  });

  it("reads the chain once for both steps", async () => {
    await _run();
    assert.equal(state.scanCount, 1);
    assert.equal(state.scanFromBlock, 100, "read from pool creation");
  });
});

describe("_scanLifetimePoolData — Re-scan Prices", () => {
  let _scanLifetimePoolData, lifetimeScanPlan;

  beforeEach(() => {
    resetState();
    state.poolCreationBlock = 100;
    installMocks();
    ({
      _scanLifetimePoolData,
      lifetimeScanPlan,
    } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  /** Every figure saved, so only the re-value can make the scan run. */
  const SAVED = {
    compoundedAmount0: 12.5,
    compoundedAmount1: 40,
    totalLifetimeDepositUsd: 1704.15,
  };

  /** One scan of a position whose figures are all saved. */
  const _run = async (botState) => {
    const position = makePosition();
    await _scanLifetimePoolData(
      position,
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    return botState;
  };

  it("re-values every stored figure at fresh prices", async () => {
    const botState = makeBotState(SAVED);
    botState._needsPriceRevalue = true;
    await _run(botState);
    assert.equal(state.classifyCalled, true, "Fees Compounded re-valued");
    assert.equal(state.depositCalled, true, "Lifetime Deposit re-valued");
    assert.equal(state.baselineRevalued, true, "HODL baseline re-valued");
  });

  it("keeps the saved HODL amounts, which no price can change", async () => {
    const botState = makeBotState(SAVED);
    botState._needsPriceRevalue = true;
    await _run(botState);
    assert.equal(
      botState.lifetimeHodlAmounts,
      state.cachedHodl,
      "the cached amounts are used, not a fresh chain-wide walk",
    );
  });

  it("answers the request once, then leaves the figures alone", async () => {
    const botState = makeBotState(SAVED);
    botState._needsPriceRevalue = true;
    await _run(botState);
    assert.equal(botState._needsPriceRevalue, false, "request answered");
    resetState();
    const plan = lifetimeScanPlan(botState, "epoch-key");
    assert.equal(plan.needed, false, "the next pass reads nothing");
  });

  it("keeps the request when the chain read fails, so it is retried", async () => {
    const botState = makeBotState(SAVED);
    botState._needsPriceRevalue = true;
    state.scanError = new Error("RPC down");
    await _run(botState);
    assert.equal(state.classifyCalled, false, "nothing was re-valued");
    assert.equal(botState._needsPriceRevalue, true, "request survives");
  });

  it("does not read the chain without a request", async () => {
    const botState = makeBotState(SAVED);
    await _run(botState);
    assert.equal(state.scanCalled, false, "every figure is saved");
    assert.equal(state.baselineRevalued, false);
  });
});
