/**
 * @file test/rebalance-activity-figures.test.js
 * @description The figures a Rebalance entry in the Activity Log keeps:
 * its Historical figure, stored the moment the rebalance succeeds, and
 * its four coin figures, finished once the Lifetime accounting has
 * counted the deposit at its mint.
 *
 * The fixture rebalance: the wallet held 100 of token0 and 50 of token1
 * before the drain; the drain brought in 1,000 of token0; the swaps sold
 * 500 of token0 for 495 of token1; so the wallet held 1,100 / 50 after
 * the drain and 600 / 545 before the mint. At $1 each, everything after
 * the drain was worth $1,150 and everything before the mint $1,145: the
 * swaps cost $5, which is -0.4367% of the position after.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  historicalAtCreation,
  figuresAtCreation,
  activityFieldsOf,
  withFinishedFigures,
  cachedDepositFor,
  loggedRebalanceFigures,
  fourNumbers,
  finishRebalanceFigures,
  figuresNeedNftEvents,
} = require("../src/rebalance-activity-figures");
const { rebalanceIlPct } = require("../src/coin-value");

const READINGS = Object.freeze({
  beforeDrain: { amount0: 100, amount1: 50 },
  afterDrain: { amount0: 1100, amount1: 50 },
  beforeMint: { amount0: 600, amount1: 545 },
});
const PRICES = { price0: 1, price1: 1 };
const IL_PCT = ((1145 - 1150) / 1145) * 100;
const MINT = 1000;
const close = (a, b) => Math.abs(a - b) < 1e-9;

describe("historicalAtCreation", () => {
  it("is the swaps' effect from after the drain to before the mint", () => {
    const h = historicalAtCreation(READINGS, PRICES);
    assert.ok(close(h.impermanentLossGainPct, IL_PCT));
  });

  it("is null without readings or prices", () => {
    assert.equal(
      historicalAtCreation(null, PRICES).impermanentLossGainPct,
      null,
    );
    assert.equal(
      historicalAtCreation(READINGS, { price0: 0, price1: 1 })
        .impermanentLossGainPct,
      null,
    );
  });
});

describe("figuresAtCreation", () => {
  it("prices the figure with the operator's overrides, as the panels do", () => {
    // No price came back for token0, and the operator saved $1 for it.
    const result = {
      walletReadings: READINGS,
      token0UsdPrice: 0,
      token1UsdPrice: 1,
    };
    const got = figuresAtCreation(result, (k) =>
      k === "priceOverride0" ? 1 : undefined,
    );
    assert.ok(close(got.historical.impermanentLossGainPct, IL_PCT));
    assert.equal(got.figuresDue, true);
  });

  it("never throws, whatever the result holds", () => {
    for (const result of [null, undefined, {}, { walletReadings: "x" }]) {
      const got = figuresAtCreation(result);
      assert.equal(got.historical.impermanentLossGainPct, null);
      assert.equal(got.figuresDue, true);
    }
  });
});

describe("activityFieldsOf", () => {
  it("hands on the readings, the Historical figure and the due marker", () => {
    const result = {
      walletReadings: READINGS,
      historical: { impermanentLossGainPct: -1 },
      figuresDue: true,
      newTokenId: 5n,
    };
    assert.deepEqual(activityFieldsOf(result), {
      walletReadings: READINGS,
      historical: { impermanentLossGainPct: -1 },
      figuresDue: true,
    });
  });

  it("hands on nothing from a result that carries no figures", () => {
    assert.deepEqual(activityFieldsOf({ newTokenId: 5n }), {});
    assert.deepEqual(activityFieldsOf(undefined), {});
  });
});

describe("withFinishedFigures", () => {
  it("puts the figures in, takes the marker away, and leaves the entry alone", () => {
    const entry = { txHash: "0xa", figuresDue: true, swapSources: "x" };
    const done = withFinishedFigures(entry, {
      walletReadings: READINGS,
      beforeRebalance: { amount0: 1, amount1: 2 },
      afterRebalance: { amount0: 3, amount1: 4 },
      historical: { impermanentLossGainPct: -1 },
    });
    assert.equal(done.figuresDue, undefined);
    assert.equal(done.swapSources, "x");
    assert.deepEqual(done.afterRebalance, { amount0: 3, amount1: 4 });
    assert.equal(entry.figuresDue, true);
    assert.equal(entry.walletReadings, undefined);
  });

  it("puts in what started the rebalance when it is known, else keeps the entry's", () => {
    const entry = { txHash: "0xa", figuresDue: true, trigger: "manual" };
    assert.equal(withFinishedFigures(entry, {}).trigger, "manual");
    assert.equal(
      withFinishedFigures(entry, { trigger: "out-of-range" }).trigger,
      "out-of-range",
    );
    assert.equal(
      "trigger" in withFinishedFigures({ txHash: "0xb" }, { trigger: null }),
      false,
    );
  });
});

describe("cachedDepositFor", () => {
  const hodl = (deposits, lastBlock = MINT) => ({ deposits, lastBlock });

  it("is null until the Lifetime accounting has reached the mint", () => {
    assert.equal(cachedDepositFor(hodl([], MINT - 1), MINT, 18, 18), null);
    assert.equal(cachedDepositFor(null, MINT, 18, 18), null);
    assert.equal(cachedDepositFor({ deposits: [] }, MINT, 18, 18), null);
  });

  it("takes the fresh deposit at the mint, in whole coins", () => {
    const deposits = [
      { raw0: "5000", raw1: "0", block: 500, kind: "fresh" },
      { raw0: "80000", raw1: "2000000", block: MINT, kind: "fresh" },
      { raw0: "999000", raw1: "999000", block: MINT, kind: "external" },
    ];
    assert.deepEqual(cachedDepositFor(hodl(deposits), MINT, 3, 6), {
      amount0: 80,
      amount1: 2,
    });
  });

  it("counts an untagged entry as fresh when it is the first for its block", () => {
    const deposits = [
      { raw0: "80", raw1: "0", block: MINT },
      { raw0: "999", raw1: "0", block: MINT },
    ];
    assert.deepEqual(cachedDepositFor(hodl(deposits), MINT, 0, 0), {
      amount0: 80,
      amount1: 0,
    });
  });

  it("is zero coins for a mint that took in no deposit", () => {
    const external = [{ raw0: "9", raw1: "9", block: MINT, kind: "external" }];
    for (const deposits of [[], external, [null, 3]])
      assert.deepEqual(cachedDepositFor(hodl(deposits), MINT, 0, 0), {
        amount0: 0,
        amount1: 0,
      });
  });

  /*-
   *  The deposit count records deposits as they arrive, each at its own
   *  block and naming its transaction, and the Lifetime scan then counts
   *  only what arrived after the count's last read. The rebalance's
   *  deposit is both: the count's entries after the old NFT's mint, up
   *  to the new one, and the scan's own at the mint.
   */
  const counted = (raw0, block, tx) => ({
    raw0: String(raw0),
    raw1: "0",
    block,
    kind: "fresh",
    txHash: tx,
  });

  it("adds the deposit count's entries since the old NFT's mint", () => {
    const deposits = [
      counted(7, 400, "0xbefore"),
      counted(30, 600, "0xa"),
      counted(20, MINT, "0xsame"),
      { raw0: "5", raw1: "0", block: MINT, kind: "fresh" },
      counted(90, MINT + 10, "0xafter"),
    ];
    assert.deepEqual(cachedDepositFor(hodl(deposits), MINT, 0, 0, 500), {
      amount0: 55,
      amount1: 0,
    });
  });

  it("does not take a recorded entry in the mint's block for the scan's own", () => {
    const deposits = [counted(20, MINT, "0xsame")];
    assert.deepEqual(cachedDepositFor(hodl(deposits), MINT, 0, 0, 500), {
      amount0: 20,
      amount1: 0,
    });
  });
});

describe("loggedRebalanceFigures", () => {
  const scope = {
    chain: "pulsechain",
    contract: "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
    wallet: "0x1111111111111111111111111111111111111111",
  };
  const entry = (over = {}) => ({
    chain: "pulsechain",
    contract: scope.contract.toLowerCase(),
    wallet: scope.wallet,
    newTokenId: "7",
    walletReadings: READINGS,
    historical: { impermanentLossGainPct: -1 },
    token0UsdPrice: 2,
    token1UsdPrice: 3,
    trigger: "residual-cleanup",
    ...over,
  });

  it("keys this scope's entries by new NFT, whatever the address case", () => {
    const got = loggedRebalanceFigures([entry()], scope);
    assert.deepEqual(got.get("7"), {
      walletReadings: READINGS,
      historical: { impermanentLossGainPct: -1 },
      prices: { price0: 2, price1: 3 },
      trigger: "residual-cleanup",
    });
  });

  it("skips another scope's entries, the test suite's, and anything damaged", () => {
    const entries = [
      null,
      3,
      {},
      entry({ wallet: "0xSIGNER0000000000000000000000000000000001" }),
      entry({ chain: "pulsechain-testnet" }),
      entry({ contract: "0x2222222222222222222222222222222222222222" }),
      entry({ newTokenId: undefined }),
      entry({
        newTokenId: 5,
        historical: "x",
        walletReadings: [1],
        trigger: 4,
      }),
    ];
    const got = loggedRebalanceFigures(entries, scope);
    assert.deepEqual([...got.keys()], ["5"]);
    assert.equal(got.get("5").historical, null);
    assert.equal(got.get("5").walletReadings, null);
    assert.equal(got.get("5").trigger, null);
    assert.equal(loggedRebalanceFigures(undefined, scope).size, 0);
  });
});

describe("fourNumbers", () => {
  it("with no deposit, is the wallet after the drain and before the mint", () => {
    const got = fourNumbers(READINGS, { amount0: 0, amount1: 0 }, null);
    assert.deepEqual(got, {
      beforeRebalance: READINGS.afterDrain,
      afterRebalance: READINGS.beforeMint,
    });
  });

  it("sets a deposit aside, and its share of the coins after the swaps", () => {
    const got = fourNumbers(READINGS, { amount0: 80, amount1: 0 }, PRICES);
    assert.deepEqual(got.beforeRebalance, { amount0: 1020, amount1: 50 });
    const share = 1070 / 1150;
    assert.ok(close(got.afterRebalance.amount0, 600 * share));
    assert.ok(close(got.afterRebalance.amount1, 545 * share));
  });

  it("leaves the percent at the rebalance's prices as it was", () => {
    /*-
     *  The deposit carries its share of the swaps' cost, so the percent
     *  is the same with or without it.
     */
    const got = fourNumbers(READINGS, { amount0: 80, amount1: 0 }, PRICES);
    const pct = rebalanceIlPct(
      got.beforeRebalance,
      got.afterRebalance,
      PRICES.price0,
      PRICES.price1,
    );
    assert.ok(close(pct, IL_PCT));
  });

  it("caps the deposit at what the wallet held before the drain", () => {
    /*-
     *  A compound swept most of the deposit into the position, which the
     *  drain then brought back: only 100 was still in the wallet.
     */
    const got = fourNumbers(READINGS, { amount0: 900, amount1: 0 }, PRICES);
    assert.deepEqual(got.beforeRebalance, { amount0: 1000, amount1: 50 });
  });

  it("is null when a reading is missing, or a deposit's share has no price", () => {
    assert.equal(
      fourNumbers(
        { ...READINGS, beforeMint: null },
        { amount0: 0, amount1: 0 },
        null,
      ),
      null,
    );
    assert.equal(fourNumbers(null, { amount0: 0, amount1: 0 }, null), null);
    assert.equal(
      fourNumbers(READINGS, { amount0: 80, amount1: 0 }, null),
      null,
    );
  });
});

describe("finishRebalanceFigures", () => {
  const EV = Object.freeze({
    txHash: "0xmint",
    oldTokenId: "6",
    newTokenId: "7",
    blockNumber: MINT,
    timestamp: 1700000000,
    figuresDue: true,
  });
  /** A context where the deposits cover the mint and nothing else is known. */
  const ctx = (over = {}) => {
    const calls = { balances: [], prices: 0, failures: 0 };
    return {
      calls,
      decimals0: 0,
      decimals1: 0,
      lifetimeHodl: { deposits: [], lastBlock: MINT },
      logged: new Map(),
      readNftEvents: async () => null,
      readBalances: async (block) => {
        calls.balances.push(block);
        return (
          { 899: READINGS.beforeDrain, 900: READINGS.afterDrain }[block] ??
          READINGS.beforeMint
        );
      },
      historicalPrices: async () => {
        calls.prices++;
        return PRICES;
      },
      onReadFailure: () => {
        calls.failures++;
      },
      ...over,
    };
  };

  it("sets aside the deposits counted after the old NFT's mint, and none before", async () => {
    /*-
     *  #6 was minted at block 700. The count recorded 30 at block 650,
     *  which #6's own mint took in, and 80 at block 800, which this
     *  rebalance took in.
     */
    const recorded = (raw0, block, tx) => ({
      raw0: String(raw0),
      raw1: "0",
      block,
      kind: "fresh",
      txHash: tx,
    });
    const c = ctx({
      lifetimeHodl: {
        deposits: [recorded(30, 650, "0xearlier"), recorded(80, 800, "0xa")],
        lastBlock: MINT,
      },
      chainEvents: [{ oldTokenId: "5", newTokenId: "6", blockNumber: 700 }, EV],
    });
    const ev = {
      ...EV,
      walletReadings: READINGS,
      historical: { impermanentLossGainPct: -7 },
    };
    const done = (await finishRebalanceFigures([ev], c)).get("0xmint");
    assert.deepEqual(done.beforeRebalance, { amount0: 1020, amount1: 50 });
  });

  it("finishes the bot's own rebalance from its readings, with no lookups", async () => {
    const ev = {
      ...EV,
      walletReadings: READINGS,
      historical: { impermanentLossGainPct: -7 },
    };
    const c = ctx();
    const done = (await finishRebalanceFigures([ev], c)).get("0xmint");
    assert.deepEqual(done.beforeRebalance, READINGS.afterDrain);
    assert.deepEqual(done.afterRebalance, READINGS.beforeMint);
    assert.deepEqual(done.historical, { impermanentLossGainPct: -7 });
    assert.equal(done.figuresDue, undefined);
    assert.equal(ev.figuresDue, true, "the event given is left as it was");
    assert.equal(c.calls.prices, 0);
    assert.deepEqual(c.calls.balances, []);
  });

  it("takes the readings, prices and trigger this install's log recorded", async () => {
    const logged = new Map([
      [
        "7",
        {
          walletReadings: READINGS,
          historical: null,
          prices: { price0: 1, price1: 1 },
          trigger: "manual",
        },
      ],
    ]);
    const c = ctx({ logged });
    const done = (await finishRebalanceFigures([EV], c)).get("0xmint");
    assert.ok(close(done.historical.impermanentLossGainPct, IL_PCT));
    assert.equal(c.calls.prices, 0);
    // A rebuild from the chain cannot know what started it; the log can.
    assert.equal(done.trigger, "manual");
  });

  it("works out again a Historical figure stored as a dash, at the mint's prices", async () => {
    /*-
     *  A price missing when the figure was first worked out leaves it a
     *  dash, on the event or in the rebalance log. Reload Current
     *  Position reads every event again, so each is due once more, and a
     *  dash counts as missing: its prices are asked for again.
     */
    const dash = { impermanentLossGainPct: null };
    const own = { ...EV, walletReadings: READINGS, historical: dash };
    const c = ctx();
    const done = (await finishRebalanceFigures([own], c)).get("0xmint");
    assert.ok(close(done.historical.impermanentLossGainPct, IL_PCT));
    assert.equal(c.calls.prices, 1);
    const entry = {
      walletReadings: READINGS,
      historical: dash,
      prices: { price0: 0, price1: 0 },
    };
    const fromLog = ctx({ logged: new Map([["7", entry]]) });
    const redone = (await finishRebalanceFigures([EV], fromLog)).get("0xmint");
    assert.ok(close(redone.historical.impermanentLossGainPct, IL_PCT));
    assert.equal(fromLog.calls.prices, 1, "past the log's missing prices");
  });

  it("leaves the dash when the prices again do not come back", async () => {
    const ev = {
      ...EV,
      walletReadings: READINGS,
      historical: { impermanentLossGainPct: null },
    };
    const c = ctx({ historicalPrices: async () => ({ price0: 0, price1: 1 }) });
    const done = (await finishRebalanceFigures([ev], c)).get("0xmint");
    assert.deepEqual(done.historical, { impermanentLossGainPct: null });
    assert.equal(done.figuresDue, undefined, "finished, not left due");
  });

  it("rebuilds a rebalance from the chain around its drain and mint", async () => {
    const nft = new Map([
      ["6", { dlEvents: [{ blockNumber: 900, txHash: "0xd" }] }],
    ]);
    const c = ctx({ readNftEvents: async () => nft });
    const done = (await finishRebalanceFigures([EV], c)).get("0xmint");
    const byBlock = (a, b) => a - b;
    assert.deepEqual(c.calls.balances.sort(byBlock), [899, 900, MINT - 1]);
    assert.deepEqual(done.walletReadings, READINGS);
    assert.ok(close(done.historical.impermanentLossGainPct, IL_PCT));
    assert.equal(c.calls.prices, 1);
  });

  it("leaves an event due until the deposits cover its mint", async () => {
    const c = ctx({ lifetimeHodl: { deposits: [], lastBlock: MINT - 1 } });
    assert.equal(
      (await finishRebalanceFigures([{ ...EV, walletReadings: READINGS }], c))
        .size,
      0,
    );
  });

  it("leaves an event due when it needs the chain and the pass read none", async () => {
    assert.equal((await finishRebalanceFigures([EV], ctx())).size, 0);
  });

  it("finishes with unknown figures when the wallet cannot be read", async () => {
    const nft = new Map([
      ["6", { dlEvents: [{ blockNumber: 900, txHash: "0xd" }] }],
    ]);
    const c = ctx({
      readNftEvents: async () => nft,
      readBalances: async () => {
        throw new Error("missing trie node");
      },
    });
    const done = (await finishRebalanceFigures([EV], c)).get("0xmint");
    assert.equal(done.walletReadings, null);
    assert.equal(done.beforeRebalance, null);
    assert.equal(done.historical.impermanentLossGainPct, null);
    assert.equal(c.calls.failures, 1);
  });

  it("finishes with unknown figures when the old NFT shows no drain", async () => {
    const nft = new Map([["6", { dlEvents: [] }]]);
    const done = (
      await finishRebalanceFigures(
        [EV],
        ctx({ readNftEvents: async () => nft }),
      )
    ).get("0xmint");
    assert.equal(done.walletReadings, null);
  });

  it("leaves an event due when working it out throws, and finishes the rest", async () => {
    const failed = [];
    const c = ctx({
      historicalPrices: async (ev) => {
        if (ev.txHash === "0xa") throw new Error("GeckoTerminal 429");
        return PRICES;
      },
      onFinishFailure: (ev, err) => failed.push([ev.txHash, err.message]),
    });
    const a = { ...EV, txHash: "0xa", walletReadings: READINGS };
    const b = {
      ...EV,
      txHash: "0xb",
      newTokenId: "8",
      walletReadings: READINGS,
    };
    const done = await finishRebalanceFigures([a, b], c);
    assert.deepEqual([...done.keys()], ["0xb"]);
    assert.deepEqual(failed, [["0xa", "GeckoTerminal 429"]]);
  });

  it("passes over events that are not due", async () => {
    const notDue = { ...EV, figuresDue: undefined, walletReadings: READINGS };
    assert.equal(
      (await finishRebalanceFigures([notDue, null, 3], ctx())).size,
      0,
    );
  });
});

describe("figuresNeedNftEvents", () => {
  const due = { figuresDue: true, txHash: "0xR" };

  it("answers yes for a waiting event with no wallet readings", () => {
    assert.equal(figuresNeedNftEvents([{ txHash: "0xS" }, due]), true);
  });

  it("answers no when every waiting event has its readings", () => {
    const withReadings = { ...due, walletReadings: READINGS };
    assert.equal(figuresNeedNftEvents([withReadings]), false);
  });

  it("answers no for events that are not waiting, and for no list", () => {
    assert.equal(figuresNeedNftEvents([{ txHash: "0xS" }, null, 3]), false);
    assert.equal(figuresNeedNftEvents(undefined), false);
  });
});
