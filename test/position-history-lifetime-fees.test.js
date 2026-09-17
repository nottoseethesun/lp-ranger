/**
 * @file test/position-history-lifetime-fees.test.js
 * @description Guards the whole-life fee figure behind the Per-Day P&L
 *   table's Fees column.
 *
 *   It must be measured across every Collect, not as
 *   `Collect(last) − DecreaseLiquidity(last)`.  That pair sees only the
 *   fees still unclaimed when the NFT was drained; anything
 *   auto-compound already swept was folded back into liquidity, so it
 *   leaves again inside the drain's DecreaseLiquidity and is subtracted
 *   straight back out.  A measured case showed $149 of a lifetime
 *   $1,084.
 *
 *   Logs are built with a real `ethers.Interface` and read back through
 *   the real parser, so these cases exercise the encode/parse path
 *   rather than a stub's idea of it.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ethers = require("ethers");

const { PM_ABI } = require("../src/pm-abi");
const { lifetimeFeeAmounts } = require("../src/compounder");
const { scanCollectAndDrain } = require("../src/position-history-scan-helpers");
const { _assembleEpoch } = require("../src/epoch-reconstructor");
const { createPnlTracker } = require("../src/pnl-tracker");

const _IFACE = new ethers.Interface(PM_ABI);
const _TOKEN_ID = 164418n;
const _RECIPIENT = "0x" + "a".repeat(40);

const _COLLECT_TOPIC = _IFACE.getEvent("Collect").topicHash;
const _DL_TOPIC = _IFACE.getEvent("DecreaseLiquidity").topicHash;

/** A real, parseable Collect log. */
function collectLog(amount0, amount1, blockNumber) {
  const { topics, data } = _IFACE.encodeEventLog("Collect", [
    _TOKEN_ID,
    _RECIPIENT,
    amount0,
    amount1,
  ]);
  return { topics, data, blockNumber };
}

/** A real, parseable DecreaseLiquidity log. */
function dlLog(liquidity, amount0, amount1, blockNumber) {
  const { topics, data } = _IFACE.encodeEventLog("DecreaseLiquidity", [
    _TOKEN_ID,
    liquidity,
    amount0,
    amount1,
  ]);
  return { topics, data, blockNumber };
}

/**
 * Provider stub dispatching on the event topic.  A value of "throw"
 * makes that event's query fail, which is what separates "no fees" from
 * "we could not read the history".
 */
function buildProvider({ collect = [], dl = [], head = 1000 }) {
  return {
    async getLogs(opts) {
      const topic = opts.topics[0];
      const set = topic === _COLLECT_TOPIC ? collect : dl;
      if (set === "throw") throw new Error("rpc unavailable");
      return set;
    },
    /*- The scan is chunked, so a "latest" upper bound is resolved to a
     *  number first.  A small head keeps these fixtures to a single
     *  window, which is what lets the call-count assertions below stay
     *  meaningful rather than becoming chunk arithmetic. */
    async getBlockNumber() {
      return head;
    },
  };
}

describe("lifetimeFeeAmounts — the formula", () => {
  it("counts fees that a compound already swept back into liquidity", () => {
    /*- The regression in one case.  100 minted; a compound collects 30
     *  of fees and re-deposits them; the drain releases 130 of
     *  principal plus 5 of fees still unclaimed.  True fees = 35. */
    const collect = [
      { amount0: 30n, amount1: 0n },
      { amount0: 135n, amount1: 0n },
    ];
    const dl = [{ liquidity: 9n, amount0: 130n, amount1: 0n }];
    assert.deepEqual(lifetimeFeeAmounts(collect, dl), {
      fees0: 35n,
      fees1: 0n,
    });
    /*- For contrast: `last Collect − last DL` is blind to the 30 that
     *  had already been compounded, and reports 5 instead of 35. */
    const lastPairOnly = collect[1].amount0 - dl[0].amount0;
    assert.equal(lastPairOnly, 5n);
  });

  it("ignores a zero-liquidity DecreaseLiquidity poke", () => {
    const collect = [{ amount0: 10n, amount1: 20n }];
    const dl = [{ liquidity: 0n, amount0: 7n, amount1: 9n }];
    assert.deepEqual(lifetimeFeeAmounts(collect, dl), {
      fees0: 10n,
      fees1: 20n,
    });
  });

  it("clamps at zero rather than reporting negative fees", () => {
    const collect = [{ amount0: 5n, amount1: 5n }];
    const dl = [{ liquidity: 1n, amount0: 9n, amount1: 9n }];
    assert.deepEqual(lifetimeFeeAmounts(collect, dl), {
      fees0: 0n,
      fees1: 0n,
    });
  });
});

describe("scanCollectAndDrain — reading it off the chain", () => {
  /** Fees derived from one shared scan, the way position-history does it. */
  async function feesFor(prov) {
    const scan = await scanCollectAndDrain("164418", prov, 500);
    return scan === null
      ? null
      : lifetimeFeeAmounts(scan.collectEvents, scan.dlEvents);
  }

  it("sums every Collect against every drained principal", async () => {
    /*-
     *  Every block at or above the 500 floor `feesFor` reads from: this
     *  stub ignores block ranges, and the read drops anything below the
     *  NFT's floor, as a real node never returns it.
     */
    const prov = buildProvider({
      collect: [collectLog(30n, 3n, 600), collectLog(135n, 12n, 700)],
      dl: [dlLog(9n, 130n, 11n, 699)],
    });
    assert.deepEqual(await feesFor(prov), { fees0: 35n, fees1: 4n });
  });

  it("fetches Collect and DecreaseLiquidity once each, not twice", async () => {
    /*- Both the exit value and the fee total are derived from this one
     *  scan.  Querying Collect a second time for the fees was the
     *  duplicate-RPC bug this shape exists to prevent. */
    const topics = [];
    const prov = {
      async getLogs(opts) {
        topics.push(opts.topics[0]);
        return opts.topics[0] === _COLLECT_TOPIC
          ? [collectLog(10n, 0n, 900)]
          : [];
      },
      async getBlockNumber() {
        return 1000;
      },
    };
    await scanCollectAndDrain("164418", prov, 1);
    assert.equal(topics.length, 2, "exactly two queries");
    assert.equal(new Set(topics).size, 2, "one Collect, one DecreaseLiquidity");
  });

  it("bounds both scans with the caller's fromBlock", async () => {
    const seen = [];
    const prov = {
      async getLogs(opts) {
        seen.push(opts.fromBlock);
        return opts.topics[0] === _COLLECT_TOPIC
          ? [collectLog(1n, 0n, 900)]
          : [];
      },
      async getBlockNumber() {
        return 13000;
      },
    };
    await scanCollectAndDrain("164418", prov, 12345);
    /*- Both queries, never block 0 — see feedback on genesis scans.
     *  The floor is what matters: no window may begin below the bound
     *  the caller gave, however many windows the range is split into. */
    assert.ok(seen.length > 0, "expected queries");
    assert.equal(Math.min(...seen), 12345);
  });

  it("returns the Collect events so the exit value can reuse them", async () => {
    const prov = buildProvider({
      collect: [collectLog(30n, 3n, 100), collectLog(135n, 12n, 200)],
      dl: [dlLog(9n, 130n, 11n, 199)],
    });
    const scan = await scanCollectAndDrain("164418", prov, 1);
    const last = scan.collectEvents[scan.collectEvents.length - 1];
    assert.equal(last.amount0, 135n);
    assert.equal(last.blockNumber, 200);
  });

  it("returns null when the Collect query fails", async () => {
    const prov = buildProvider({ collect: "throw", dl: [] });
    assert.equal(await scanCollectAndDrain("164418", prov, 1), null);
  });

  it("returns null when the DecreaseLiquidity query fails", async () => {
    /*- Without the principal side the subtraction would credit the
     *  whole drained position as fees. */
    const prov = buildProvider({
      collect: [collectLog(135n, 0n, 200)],
      dl: "throw",
    });
    assert.equal(await scanCollectAndDrain("164418", prov, 1), null);
  });

  it("returns null — not zero — when no Collect was found at all", async () => {
    /*- A closed NFT always emitted a Collect when it was drained, so an
     *  empty result means the scan missed the history.  Zero would
     *  overwrite a real logged figure with a wrong one. */
    const prov = buildProvider({ collect: [], dl: [dlLog(9n, 130n, 0n, 199)] });
    assert.equal(await scanCollectAndDrain("164418", prov, 1), null);
  });
});

describe("epoch assembly — where the corrected fee lands", () => {
  const history = {
    mintDate: "2026-07-01T00:00:00.000Z",
    closeDate: "2026-07-02T00:00:00.000Z",
    entryValueUsd: 1000,
    exitValueUsd: 1100,
    gasCostUsd: 1,
    entryAmount0: 10,
    entryAmount1: 20,
  };

  it("reports the whole-life fee in both fee fields", () => {
    const ep = _assembleEpoch({ ...history, feesEarnedUsd: 35 }, 0);
    assert.equal(ep.fees, 35);
    assert.equal(ep.feePnl, 35);
  });

  it("takes the fee back out of Price P&L", () => {
    /*- Compounded fees sit inside exitValue, having been added to
     *  liquidity.  priceChangePnl is exit − entry − fees, so a fee
     *  figure that missed them credited that money to price movement.
     *  Correcting fees moves it between the two columns; Net P&L, which
     *  adds them back together, must not move. */
    const understated = _assembleEpoch({ ...history, feesEarnedUsd: 5 }, 0);
    const corrected = _assembleEpoch({ ...history, feesEarnedUsd: 35 }, 0);

    assert.equal(understated.priceChangePnl, 95);
    assert.equal(corrected.priceChangePnl, 65);

    const net = (e) => e.priceChangePnl + e.feePnl - e.gas;
    assert.equal(net(corrected), net(understated));

    /*- Profit is fees − gas ± IL, so it moves by the whole correction. */
    assert.equal(corrected.feePnl - corrected.gas, 34);
    assert.equal(understated.feePnl - understated.gas, 4);
  });
});

describe("per-day IL — a difference, with no fees in it", () => {
  const { _buildDailyPnl } = require("../src/pnl-tracker");

  /** One closed epoch: 100 of each token deposited, prices 1.0 at close. */
  function epoch(fees, exitValue) {
    return {
      id: 1,
      openTime: Date.parse("2026-07-01T00:00:00Z"),
      closeTime: Date.parse("2026-07-02T00:00:00Z"),
      entryValue: 200,
      exitValue,
      fees,
      feePnl: fees,
      /*- What _assembleEpoch stores: exit - entry - fees. */
      priceChangePnl: exitValue - 200 - fees,
      gas: 1,
      hodlAmount0: 100,
      hodlAmount1: 100,
      token0UsdExit: 1,
      token1UsdExit: 1,
      status: "closed",
    };
  }

  it("takes fees out of the exit value before comparing to HODL", () => {
    /*- `exitValue` is the NFT's final Collect, which returns principal
     *  PLUS accrued fees. HODL is the deposited amounts only. Leaving
     *  the fees in would compare earnings-inclusive LP against a
     *  bare HODL basket. LP value here is 210 - 30 = 180 against a
     *  HODL of 200, so IL is -20. */
    const [day] = _buildDailyPnl([epoch(30, 210)], null);
    assert.equal(day.il, -20);
  });

  it("reports the same IL however the fees were taken", () => {
    /*- Two positions that performed identically apart from earning
     *  different fees must not report different impermanent loss. */
    const a = _buildDailyPnl([epoch(0, 180)], null)[0];
    const b = _buildDailyPnl([epoch(30, 210)], null)[0];
    assert.equal(a.il, b.il);
  });

  it("leaves fees counted exactly once in Profit", () => {
    /*- Profit is fees - gas + IL. With IL now fee-free that is
     *  30 - 1 + (-20) = 9. Before the fix IL carried the 30 as well
     *  and the same row read 39. */
    const [day] = _buildDailyPnl([epoch(30, 210)], null);
    assert.equal(day.feePnl - day.gasCost + day.il, 9);
  });

  it("does not disturb Net P&L, which never included IL", () => {
    const [day] = _buildDailyPnl([epoch(30, 210)], null);
    /*- exit - entry - gas = 210 - 200 - 1. */
    assert.equal(day.netPnl, 9);
  });
});

describe("updateLiveEpoch — today's row", () => {
  /** A tracker with one open epoch. */
  function openTracker() {
    const t = createPnlTracker();
    t.openEpoch({
      entryValue: 2000,
      entryPrice: 0.0004,
      lowerPrice: 0.00032,
      upperPrice: 0.00048,
    });
    return t;
  }

  it("adds fees already compounded to the fees still unclaimed", () => {
    const t = openTracker();
    t.updateLiveEpoch({
      currentPrice: 0.0004,
      feesAccrued: 3.73,
      compoundedAccrued: 7.17,
    });
    const snap = t.snapshot(0.0004);
    assert.equal(Math.round(snap.liveEpoch.fees * 100) / 100, 10.9);
    assert.equal(snap.liveEpoch.feePnl, snap.liveEpoch.fees);
  });

  it("treats an absent compounded figure as zero", () => {
    /*- The first poll after a rebalance mints a new tokenId has no
     *  per-NFT compound scan yet. */
    const t = openTracker();
    t.updateLiveEpoch({ currentPrice: 0.0004, feesAccrued: 3.73 });
    assert.equal(t.snapshot(0.0004).liveEpoch.fees, 3.73);
  });

  it("carries the combined figure into the closed epoch", () => {
    const t = openTracker();
    t.updateLiveEpoch({
      currentPrice: 0.0004,
      feesAccrued: 3,
      compoundedAccrued: 7,
    });
    t.closeEpoch({ exitValue: 2100, gasCost: 1, token0UsdPrice: 1 });
    const closed = t.snapshot(0.0004).closedEpochs[0];
    assert.equal(closed.feePnl, 10);
    /*- exit − entry − fees = 2100 − 2000 − 10. */
    assert.equal(closed.priceChangePnl, 90);
  });
});
