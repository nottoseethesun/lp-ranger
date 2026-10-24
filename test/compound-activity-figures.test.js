/**
 * @file test/compound-activity-figures.test.js
 * @description The figures a Compound entry in the Activity Log keeps:
 * the fee coins it collected, and their share of the position at the
 * moment of the compound, whether the bot recorded it live or a rebuild
 * found it on the chain; and what a rebuild keeps of what the bot
 * recorded. The figure the bot records live has its own file,
 * test/compound-figures-at-creation.test.js, split at the 500-line cap.
 *
 * The fixture NFT: minted at block 100 with liquidity 1,300, drained of
 * 400 at block 3,000, its fees collected at block 5,000 (10 of token0, 20
 * of token1), and those fees compounded at block 5,005 (8 of token0, 16
 * of token1, liquidity 100). At $2 and $1 the fees were worth $40 and the
 * deposit $32. The deposit is a tenth of the liquidity after it
 * (100 of 1,000), so the position was worth $320, and the fees 12.5% of
 * it.
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { readBotConfigDefaults } = require("../src/bot-config-defaults");

/*-
 *  The historical price lookup is the module's one way out of the
 *  process. It is replaced while the module loads, so the lookup it
 *  holds is this stub.
 */
const _priceCalls = [];
let _prices = { price0: 2, price1: 1 };
const _origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "./price-fetcher")
    return {
      fetchHistoricalPriceGecko: async (...args) => {
        _priceCalls.push(args);
        return _prices;
      },
    };
  return _origRequire.apply(this, arguments);
};
delete require.cache[require.resolve("../src/compound-activity-figures")];
const {
  compoundFiguresFromChain,
  compoundHistoryFrom,
  compoundPricesFor,
} = require("../src/compound-activity-figures");
Module.prototype.require = _origRequire;

const SPAN = readBotConfigDefaults().getLogsChunkSize;
const COMPOUND_TX = "0x" + "c1".repeat(32);
const WHEN = "2026-10-04T12:00:00.000Z";

/** An NFT event as the batch read decodes it. */
const ev = (blockNumber, txHash, amount0, amount1, liquidity) => ({
  blockNumber,
  txHash,
  amount0: BigInt(amount0),
  amount1: BigInt(amount1),
  liquidity: liquidity === undefined ? undefined : BigInt(liquidity),
});

/** The fixture NFT's events. */
function nftEvents() {
  return {
    ilEvents: [
      ev(100, "0xmint", 1000, 1000, 1300),
      ev(5005, COMPOUND_TX, 8, 16, 100),
    ],
    collectEvents: [ev(5000, "0xcollect", 10, 20)],
    dlEvents: [ev(3000, "0xdrain", 300, 300, 400)],
  };
}

const COMPOUND = Object.freeze({
  txHash: COMPOUND_TX,
  timestamp: WHEN,
  tokenId: "7",
  amount0Deposited: "8",
  amount1Deposited: "16",
  usdValue: 32,
});

/*-
 *  Options as the rebuild passes them, with each price lookup recorded
 *  as the time and block it was asked for. `price0` and `price1` are the
 *  scan's prices, which each compound's `usdValue` was worked out at.
 */
function opts(over = {}) {
  const asked = [];
  return {
    asked,
    decimals0: 0,
    decimals1: 0,
    price0: 2,
    price1: 1,
    compoundPrices: async (timestamp, blockNumber) => {
      asked.push([timestamp, blockNumber]);
      return { price0: 2, price1: 1 };
    },
    ...over,
  };
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

describe("compoundFiguresFromChain", () => {
  it("pairs the deposit with its collect and values both at the deposit's block", async () => {
    const o = opts();
    const got = await compoundFiguresFromChain(COMPOUND, nftEvents(), o);
    assert.deepEqual(got.feesCollected, { amount0: 10, amount1: 20 });
    assert.ok(close(got.historical.percentGainForPosition, 12.5));
    assert.deepEqual(o.asked, [[WHEN, 5005]]);
  });

  it("finds the deposit whatever the case of its hash", async () => {
    const upper = { ...COMPOUND, txHash: COMPOUND_TX.toUpperCase() };
    const got = await compoundFiguresFromChain(upper, nftEvents(), opts());
    assert.ok(close(got.historical.percentGainForPosition, 12.5));
  });

  it("is 0% for coins the owner added, with no price lookup", async () => {
    const nft = nftEvents();
    nft.collectEvents = [];
    const o = opts();
    const got = await compoundFiguresFromChain(COMPOUND, nft, o);
    assert.deepEqual(got, {
      feesCollected: { amount0: 0, amount1: 0 },
      historical: { percentGainForPosition: 0 },
    });
    assert.deepEqual(o.asked, []);
  });

  it("is 0% when another deposit came after the collect", async () => {
    const nft = nftEvents();
    nft.ilEvents.splice(1, 0, ev(5002, "0xowner", 1, 1, 5));
    const got = await compoundFiguresFromChain(COMPOUND, nft, opts());
    assert.equal(got.historical.percentGainForPosition, 0);
  });

  it("looks for the collect no further back than one span of blocks", async () => {
    // The collect at block 1,000 is one block older than the span reaches.
    const nft = nftEvents();
    nft.collectEvents = [ev(1000, "0xcollect", 10, 20)];
    nft.ilEvents[1] = ev(1000 + SPAN, COMPOUND_TX, 8, 16, 100);
    const got = await compoundFiguresFromChain(COMPOUND, nft, opts());
    assert.equal(got.historical.percentGainForPosition, 0);
    nft.collectEvents = [ev(1001, "0xcollect", 10, 20)];
    const inside = await compoundFiguresFromChain(COMPOUND, nft, opts());
    assert.ok(close(inside.historical.percentGainForPosition, 12.5));
  });

  it("is unknown without its prices, keeping the fee coins", async () => {
    // No prices to be had, a lookup that fails, and no way to look.
    const lookups = [
      async () => null,
      async () => {
        throw new Error("GeckoTerminal 429");
      },
      undefined,
    ];
    for (const compoundPrices of lookups) {
      const o = opts({ compoundPrices, token0Symbol: "A", token1Symbol: "B" });
      const got = await compoundFiguresFromChain(COMPOUND, nftEvents(), o);
      assert.deepEqual(got.feesCollected, { amount0: 10, amount1: 20 });
      assert.equal(got.historical.percentGainForPosition, null);
    }
  });

  it("is unknown when the lookup has a price for only one coin", async () => {
    const days = [
      { price0: 0, price1: 1 },
      { price0: 2, price1: undefined },
    ];
    for (const day of days) {
      const o = opts({ compoundPrices: async () => day });
      const got = await compoundFiguresFromChain(COMPOUND, nftEvents(), o);
      assert.deepEqual(got.feesCollected, { amount0: 10, amount1: 20 });
      assert.equal(got.historical.percentGainForPosition, null);
    }
  });

  it("is unknown without the NFT's events, its deposit, or usable decimals", async () => {
    const unknown = {
      feesCollected: null,
      historical: { percentGainForPosition: null },
    };
    const other = { ...COMPOUND, txHash: "0x" + "dd".repeat(32) };
    assert.deepEqual(
      await compoundFiguresFromChain(COMPOUND, undefined, opts()),
      unknown,
    );
    assert.deepEqual(
      await compoundFiguresFromChain(other, nftEvents(), opts()),
      unknown,
    );
    assert.deepEqual(
      await compoundFiguresFromChain(
        COMPOUND,
        nftEvents(),
        opts({ decimals0: -1 }),
      ),
      unknown,
    );
  });
});

describe("compoundHistoryFrom", () => {
  const events = () => new Map([["7", nftEvents()]]);
  const READ_AT = Date.parse("2026-10-05T00:00:00.000Z");

  it("writes a compound found only on the chain with trigger unknown", async () => {
    const got = await compoundHistoryFrom([COMPOUND], events(), opts());
    assert.equal(got.length, 1);
    assert.deepEqual(
      { ...got[0], historical: undefined },
      {
        timestamp: WHEN,
        txHash: COMPOUND_TX,
        tokenId: "7",
        amount0Deposited: "8",
        amount1Deposited: "16",
        usdValue: 32,
        trigger: "unknown",
        feesCollected: { amount0: 10, amount1: 20 },
        historical: undefined,
      },
    );
    assert.ok(close(got[0].historical.percentGainForPosition, 12.5));
  });

  it("keeps the trigger and figures the bot recorded live, matched by hash", async () => {
    const saved = [
      {
        ...COMPOUND,
        txHash: COMPOUND_TX.toUpperCase(),
        trigger: "auto",
        feesCollected: { amount0: 1, amount1: 2 },
        historical: { percentGainForPosition: 3 },
      },
    ];
    const o = opts({ savedCompoundHistory: () => saved });
    const got = await compoundHistoryFrom([COMPOUND], events(), o);
    assert.equal(got.length, 1);
    assert.equal(got[0].trigger, "auto");
    assert.equal(got[0].txHash, COMPOUND_TX);
    assert.deepEqual(got[0].feesCollected, { amount0: 1, amount1: 2 });
    assert.deepEqual(got[0].historical, { percentGainForPosition: 3 });
    assert.deepEqual(o.asked, [], "a stored figure is never worked out again");
  });

  it("keeps the fees the bot recorded its deposit put back", async () => {
    /*-
     *  The chain shows only the whole deposit, 8 + 16. Rebuilt without
     *  the record's fees, 2 + 4, the list would count as fees again the
     *  coins the wallet already held that the compound's deposit took
     *  in, on every Reload Current Position and Re-scan Prices.
     */
    const saved = [
      {
        ...COMPOUND,
        trigger: "manual",
        amount0Compounded: "2",
        amount1Compounded: "4",
      },
    ];
    const o = opts({ savedCompoundHistory: () => saved });
    const got = await compoundHistoryFrom([COMPOUND], events(), o);
    assert.equal(got[0].amount0Deposited, "8");
    assert.equal(got[0].amount0Compounded, "2");
    assert.equal(got[0].amount1Compounded, "4");
    assert.equal("amount0FeesLeft" in got[0], false, "none recorded");
  });

  it("keeps the fees the bot recorded its deposit left in the wallet", async () => {
    /*-
     *  Only the compound's own record knows them: the chain shows the
     *  deposit, not the fee coins after the swap. Rebuilt without them,
     *  the Current panel would lose those fees on every Reload Current
     *  Position and Re-scan Prices.
     */
    const saved = [
      {
        ...COMPOUND,
        trigger: "auto",
        amount0Compounded: "2",
        amount1Compounded: "4",
        amount0FeesLeft: "1",
        amount1FeesLeft: "0",
      },
    ];
    const o = opts({ savedCompoundHistory: () => saved });
    const got = await compoundHistoryFrom([COMPOUND], events(), o);
    assert.equal(got[0].amount0FeesLeft, "1");
    assert.equal(got[0].amount1FeesLeft, "0");
  });

  it("writes a live entry's $usd at the rebuild's prices, without the compound's own", async () => {
    /*-
     *  The Activity Log marks an amount "(historical $usd)" while its
     *  record carries the prices of the compound's own time
     *  (public/dashboard-compound-log.js). A rebuild writes each amount
     *  at the prices it was handed, so the entry it writes carries none.
     *  A compound recorded during the chain read is kept as recorded.
     */
    const live = {
      ...COMPOUND,
      usdValue: 50,
      price0: 3,
      price1: 2,
      trigger: "auto",
      historical: { percentGainForPosition: 3 },
    };
    const during = {
      txHash: "0x" + "ee".repeat(32),
      timestamp: "2026-10-05T00:00:01.000Z",
      usdValue: 7,
      price0: 3,
      price1: 2,
      trigger: "manual",
    };
    const o = opts({
      savedCompoundHistory: () => [live, during],
      readStartedAt: READ_AT,
    });
    const got = await compoundHistoryFrom([COMPOUND], events(), o);
    assert.equal(got[0].usdValue, 32, "the rebuild's amount");
    assert.equal(got[0].trigger, "auto");
    assert.ok(!("price0" in got[0]) && !("price1" in got[0]));
    assert.deepEqual(got[1], during);
  });

  it("works out figures from the chain for a live entry that has none", async () => {
    const saved = [{ ...COMPOUND, trigger: "manual" }];
    const o = opts({ savedCompoundHistory: () => saved });
    const got = await compoundHistoryFrom([COMPOUND], events(), o);
    assert.equal(got[0].trigger, "manual");
    assert.ok(close(got[0].historical.percentGainForPosition, 12.5));
  });

  it("does not take an entry a rebuild wrote for one the bot recorded", async () => {
    for (const trigger of ["historical", "unknown"]) {
      const saved = [
        {
          ...COMPOUND,
          trigger,
          historical: { percentGainForPosition: 99 },
        },
      ];
      const o = opts({ savedCompoundHistory: () => saved });
      const got = await compoundHistoryFrom([COMPOUND], events(), o);
      assert.equal(got[0].trigger, "unknown");
      assert.ok(close(got[0].historical.percentGainForPosition, 12.5));
    }
  });

  it("keeps the figure an earlier rebuild worked out when this one's lookup answers nothing", async () => {
    /*-
     *  Re-scan Prices reads past the price cache, and a lookup that fails
     *  answers a zero, or nothing, for a coin. A figure the entry already
     *  holds stands; with none, the entry is unknown.
     */
    const earlier = {
      ...COMPOUND,
      trigger: "unknown",
      feesCollected: { amount0: 10, amount1: 20 },
      historical: { percentGainForPosition: 9.5 },
    };
    const lookups = [
      async () => ({ price0: 0, price1: 1 }),
      async () => null,
      async () => {
        throw new Error("Moralis 429");
      },
    ];
    for (const compoundPrices of lookups) {
      const o = opts({ compoundPrices, savedCompoundHistory: () => [earlier] });
      const [got] = await compoundHistoryFrom([COMPOUND], events(), o);
      assert.equal(got.trigger, "unknown");
      assert.deepEqual(got.historical, { percentGainForPosition: 9.5 });
      assert.deepEqual(got.feesCollected, { amount0: 10, amount1: 20 });
      const none = opts({ compoundPrices });
      const [fresh] = await compoundHistoryFrom([COMPOUND], events(), none);
      assert.deepEqual(fresh.historical, { percentGainForPosition: null });
    }
  });

  it("works out a figure the bot recorded as a dash, keeping Auto or Manual", async () => {
    /*-
     *  A compound made while one coin's price was missing records its
     *  figure as unknown, which the Activity Log shows as a dash. Re-scan
     *  Prices and Reload Current Position both rebuild the list, asking
     *  for the prices at the compound's deposit again; a lookup that
     *  again answers nothing leaves the dash.
     */
    const live = {
      ...COMPOUND,
      trigger: "manual",
      feesCollected: { amount0: 10, amount1: 20 },
      historical: { percentGainForPosition: null },
    };
    const o = opts({ savedCompoundHistory: () => [live] });
    const [filled] = await compoundHistoryFrom([COMPOUND], events(), o);
    assert.equal(filled.trigger, "manual");
    assert.ok(close(filled.historical.percentGainForPosition, 12.5));
    assert.equal(o.asked.length, 1, "its prices asked for again");
    const failing = opts({
      savedCompoundHistory: () => [live],
      compoundPrices: async () => ({ price0: 0, price1: 1 }),
    });
    const [again] = await compoundHistoryFrom([COMPOUND], events(), failing);
    assert.equal(again.trigger, "manual");
    assert.deepEqual(again.historical, { percentGainForPosition: null });
    assert.deepEqual(again.feesCollected, { amount0: 10, amount1: 20 });
  });

  it("keeps an entry's amount, and its prices, when the scan has no price for a coin", async () => {
    /*-
     *  The rebuild's amount is worked out at the scan's prices, so with
     *  one of them missing it counts only the other coin. The saved
     *  amount stands instead, with the prices that mark it as at the
     *  compound's time; a compound with no saved entry takes the
     *  rebuild's.
     */
    const live = {
      ...COMPOUND,
      usdValue: 50,
      price0: 3,
      price1: 2,
      trigger: "auto",
      historical: { percentGainForPosition: 3 },
    };
    const rebuilt = { ...COMPOUND, usdValue: 40, trigger: "unknown" };
    for (const missing of [{ price0: 0 }, { price1: undefined }]) {
      const keep = opts({ ...missing, savedCompoundHistory: () => [live] });
      const [kept] = await compoundHistoryFrom([COMPOUND], events(), keep);
      assert.equal(kept.usdValue, 50);
      assert.deepEqual([kept.price0, kept.price1], [3, 2]);
      assert.equal(kept.trigger, "auto");
      const again = opts({ ...missing, savedCompoundHistory: () => [rebuilt] });
      const [same] = await compoundHistoryFrom([COMPOUND], events(), again);
      assert.equal(same.usdValue, 40);
      assert.ok(!("price0" in same) && !("price1" in same));
      const fresh = opts(missing);
      const [found] = await compoundHistoryFrom([COMPOUND], events(), fresh);
      assert.equal(found.usdValue, 32, "the rebuild's own, with nothing saved");
    }
  });

  it("keeps a live compound the chain read began too early to see", async () => {
    const during = {
      txHash: "0x" + "ee".repeat(32),
      timestamp: "2026-10-05T00:00:01.000Z",
      trigger: "manual",
    };
    const before = {
      txHash: "0x" + "ff".repeat(32),
      timestamp: "2026-10-04T23:59:59.000Z",
      trigger: "auto",
    };
    const o = opts({
      savedCompoundHistory: () => [before, during],
      readStartedAt: READ_AT,
    });
    const got = await compoundHistoryFrom([COMPOUND], events(), o);
    assert.deepEqual(
      got.map((e) => e.txHash),
      [COMPOUND_TX, during.txHash],
    );
    assert.equal(got[1], during, "kept as it was saved");
  });

  it("keeps a compound the bot records while the rebuild waits on prices", async () => {
    /*-
     *  A Compound Now can run while the rebuild waits on a compound's
     *  prices.
     *  The caller writes what the rebuild returns with no wait in
     *  between, so the compound is kept only if the rebuild reads the
     *  saved list after its last wait.
     */
    const during = {
      txHash: "0x" + "ee".repeat(32),
      timestamp: "2026-10-05T00:00:01.000Z",
      trigger: "manual",
    };
    const saved = [];
    const o = opts({
      savedCompoundHistory: () => saved,
      readStartedAt: READ_AT,
      compoundPrices: async () => {
        saved.push(during);
        return { price0: 2, price1: 1 };
      },
    });
    const got = await compoundHistoryFrom([COMPOUND], events(), o);
    assert.deepEqual(
      got.map((e) => e.txHash),
      [COMPOUND_TX, during.txHash],
    );
  });

  it("keeps no unmatched entry when the read's start is not known", async () => {
    const during = {
      txHash: "0x" + "ee".repeat(32),
      timestamp: "2026-10-05T00:00:01.000Z",
      trigger: "manual",
    };
    const o = opts({ savedCompoundHistory: () => [during] });
    const got = await compoundHistoryFrom([COMPOUND], events(), o);
    assert.equal(got.length, 1);
  });

  it("reads past a damaged saved list", async () => {
    const saved = [null, 3, { trigger: "auto" }, { txHash: 5 }];
    for (const savedCompoundHistory of [() => saved, () => null, undefined]) {
      const o = opts({ savedCompoundHistory, readStartedAt: READ_AT });
      const got = await compoundHistoryFrom([COMPOUND], events(), o);
      assert.equal(got.length, 1);
      assert.equal(got[0].trigger, "unknown");
    }
  });
});

describe("compoundPricesFor", () => {
  const POSITION = { token0: "0xT0", token1: "0xT1" };

  beforeEach(() => {
    _priceCalls.length = 0;
    _prices = { price0: 2, price1: 1 };
  });

  it("asks for the prices in the pool at the deposit's block, with its time in Unix seconds", async () => {
    const lookup = compoundPricesFor(
      POSITION,
      { poolAddress: "0xFromState" },
      { poolAddress: "0xFromCache" },
      false,
    );
    assert.deepEqual(await lookup(WHEN, 5005), { price0: 2, price1: 1 });
    assert.deepEqual(_priceCalls, [
      [
        "0xFromCache",
        Date.parse(WHEN) / 1000,
        {
          token0Address: "0xT0",
          token1Address: "0xT1",
          blockNumber: 5005,
          refresh: false,
        },
      ],
    ]);
  });

  it("takes the pool from the poll when the epoch cache has none, and reads past the cache on Re-scan Prices", async () => {
    const lookup = compoundPricesFor(
      POSITION,
      { poolAddress: "0xFromState" },
      null,
      true,
    );
    await lookup(WHEN);
    assert.equal(_priceCalls[0][0], "0xFromState");
    assert.equal(_priceCalls[0][2].refresh, true);
  });

  it("asks nothing for a compound with no time", async () => {
    const lookup = compoundPricesFor(POSITION, {}, null, false);
    assert.equal(await lookup(null), null);
    assert.equal(await lookup("not a date"), null);
    assert.deepEqual(_priceCalls, []);
  });
});
