/**
 * @file test/epoch-reconstructor.test.js
 * @description Unit tests for the epoch-reconstructor module.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const {
  _buildClosedEpoch,
  isEpochHistoryComplete,
  reconstructEpochs,
} = require("../src/epoch-reconstructor");

describe("_buildClosedEpoch", () => {
  it("returns null when no dates available", () => {
    assert.strictEqual(
      _buildClosedEpoch({ mintDate: null, closeDate: null }, 0),
      null,
    );
  });

  it("builds epoch from position history data", () => {
    const h = {
      mintDate: "2026-03-15T10:00:00Z",
      closeDate: "2026-03-17T14:00:00Z",
      entryValueUsd: 300,
      exitValueUsd: 295,
      feesEarnedUsd: 0.5,
      token0UsdPriceAtOpen: 0.0016,
      token1UsdPriceAtOpen: 0.0006,
      token0UsdPriceAtClose: 0.0017,
      token1UsdPriceAtClose: 0.00059,
    };
    const ep = _buildClosedEpoch(h, 0);
    assert.strictEqual(ep.status, "closed");
    assert.strictEqual(ep.entryValue, 300);
    assert.strictEqual(ep.exitValue, 295);
    assert.strictEqual(ep.fees, 0.5);
    assert.strictEqual(ep.feePnl, 0.5);
    assert.strictEqual(ep.priceChangePnl, 295 - 300 - 0.5);
    assert.strictEqual(ep.openTime, new Date("2026-03-15T10:00:00Z").getTime());
    assert.strictEqual(
      ep.closeTime,
      new Date("2026-03-17T14:00:00Z").getTime(),
    );
    assert.strictEqual(ep.id, 1);
    assert.strictEqual(ep.color, "#00e5ff");
  });

  it("uses openTime as closeTime fallback when closeDate is null", () => {
    const h = {
      mintDate: "2026-03-15T10:00:00Z",
      closeDate: null,
      entryValueUsd: 100,
      exitValueUsd: 0,
      feesEarnedUsd: 0,
    };
    const ep = _buildClosedEpoch(h, 0);
    assert.ok(ep);
    assert.strictEqual(ep.closeTime, ep.openTime);
  });

  it("returns null when exitValueUsd is missing", () => {
    const h = {
      mintDate: "2026-03-15T10:00:00Z",
      closeDate: "2026-03-16T10:00:00Z",
      entryValueUsd: 293.99,
      exitValueUsd: null,
      feesEarnedUsd: null,
    };
    assert.strictEqual(_buildClosedEpoch(h, 2), null);
  });

  it("assigns correct colour per index", () => {
    const h = {
      mintDate: "2026-01-01T00:00:00Z",
      closeDate: "2026-01-02T00:00:00Z",
      entryValueUsd: 100,
      exitValueUsd: 100,
      feesEarnedUsd: 1,
    };
    assert.strictEqual(_buildClosedEpoch(h, 0).color, "#00e5ff");
    assert.strictEqual(_buildClosedEpoch(h, 1).color, "#ff6b35");
    assert.strictEqual(_buildClosedEpoch(h, 10).color, "#00e5ff"); // wraps
  });

  it("computes epochPnl correctly", () => {
    const h = {
      mintDate: "2026-01-01T00:00:00Z",
      closeDate: "2026-01-02T00:00:00Z",
      entryValueUsd: 200,
      exitValueUsd: 190,
      feesEarnedUsd: 3,
    };
    const ep = _buildClosedEpoch(h, 0);
    // epochPnl = (exit - entry) + fees = (190 - 200) + 3 = -7
    assert.strictEqual(ep.epochPnl, -7);
    // priceChangePnl = exit - entry - fees = 190 - 200 - 3 = -13
    assert.strictEqual(ep.priceChangePnl, -13);
  });
});

describe("epoch-cache round-trip", () => {
  const { getCachedEpochs, setCachedEpochs } = require("../src/epoch-cache");
  const key = {
    blockchain: "test",
    contract: "0xPM",
    wallet: "0xW",
    token0: "0xA",
    token1: "0xB",
    fee: 3000,
  };
  it("stores and retrieves tracker state", () => {
    const data = { closedEpochs: [{ e: 1 }], liveEpoch: null };
    setCachedEpochs(key, data);
    const got = getCachedEpochs(key);
    assert.deepStrictEqual(got.closedEpochs, [{ e: 1 }]);
  });
  it("normalizes plain array to full state", () => {
    setCachedEpochs(key, [{ e: 2 }]);
    const got = getCachedEpochs(key);
    assert.deepStrictEqual(got.closedEpochs, [{ e: 2 }]);
    assert.strictEqual(got.liveEpoch, null);
  });
});

describe("isEpochHistoryComplete", () => {
  /*- The guard that decides whether reconstruction runs at all.  It used
   *  to ask "do we have ANY closed epochs?", which treated a partial
   *  history as a finished one.  The position it broke was the only pool
   *  the bot had rebalanced itself: eight epochs closed live during that
   *  window, so reconstruction returned at the first line and the 124
   *  rebalances either side of it never got an epoch — leaving the
   *  Per-Day P&L table blank on every day but one. */
  const ids = (n) => Array.from({ length: n }, (_, i) => String(i + 1));

  it("is false when the history covers only part of the chain", () => {
    assert.strictEqual(isEpochHistoryComplete(new Array(8), ids(132)), false);
  });

  it("is false for a single live-recorded epoch on a long chain", () => {
    /*- The hardest shape to get right: one rebalance by this bot on a
     *  position with a long prior history, so the epoch count is
     *  plausible while the chain is almost entirely unreconstructed. */
    assert.strictEqual(isEpochHistoryComplete(new Array(1), ids(40)), false);
  });

  it("is true once every closed position has an epoch", () => {
    assert.strictEqual(isEpochHistoryComplete(new Array(37), ids(37)), true);
  });

  it("is true when the history runs ahead of the chain", () => {
    /*- A live close lands before the event scanner catches up.  Treat
     *  that as complete rather than rebuilding on every poll. */
    assert.strictEqual(isEpochHistoryComplete(new Array(38), ids(37)), true);
  });

  it("is false when there is no history at all", () => {
    assert.strictEqual(isEpochHistoryComplete([], ids(3)), false);
    assert.strictEqual(isEpochHistoryComplete(undefined, ids(3)), false);
  });
});

describe("reconstructEpochs — when it decides to run", () => {
  /*- Drives the real function.  Every collaborator that would touch the
   *  chain is absent, so a run that gets past the guard fails loudly
   *  rather than silently reaching for RPC. */
  const events = (n) =>
    Array.from({ length: n }, (_, i) => ({
      oldTokenId: String(1000 + i),
      newTokenId: String(1001 + i),
    }));

  const tracker = (closedCount) => ({
    serialize: () => ({
      closedEpochs: new Array(closedCount).fill({}),
      liveEpoch: null,
    }),
    restore: () => {},
  });

  it("skips when the history already covers the chain", async () => {
    const n = await reconstructEpochs({
      pnlTracker: tracker(5),
      rebalanceEvents: events(5),
      botState: {},
    });
    assert.strictEqual(n, 0);
  });

  it("does NOT skip a partial history — the regression", async () => {
    /*- Eight epochs against a 132-rebalance chain.  Before the fix this
     *  returned 0 immediately.  It must now get past the guard; with no
     *  position metadata it can build no cache key and no epochs, so it
     *  still returns 0 — the distinction is that it TRIED, which the
     *  progress callback records. */
    let reached = false;
    await reconstructEpochs({
      pnlTracker: tracker(8),
      rebalanceEvents: events(132),
      botState: { activePosition: null },
      updateBotState: () => {
        reached = true;
      },
    });
    assert.ok(
      reached,
      "reconstruction did not get past the completeness guard",
    );
  });

  it("still skips when the chain closed nothing", async () => {
    const n = await reconstructEpochs({
      pnlTracker: tracker(0),
      rebalanceEvents: [{ oldTokenId: "?", newTokenId: "2" }],
      botState: {},
    });
    assert.strictEqual(n, 0);
  });
});
