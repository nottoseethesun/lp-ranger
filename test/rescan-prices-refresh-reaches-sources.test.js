/**
 * @file test/rescan-prices-refresh-reaches-sources.test.js
 * @description The Re-scan Prices opt-in end to end, from the flag on
 *   the bot state to the two price calls that have to honour it.
 *
 *   The request travels several hops, and every hop is somewhere it can
 *   be dropped in silence: a renamed property, a positional argument
 *   passed in the wrong slot, a default that overrides. Every one of
 *   those failures looks identical from outside — the scan runs, the
 *   epochs rebuild, the request reports success, and the suspect price
 *   is read straight back out of the cache it was stored in.
 *
 *   Each hop tested alone would not catch that: the handoffs are what
 *   break. So these drive the flag in at the top and observe what
 *   arrives at the bottom.
 *
 *   The pair-token price and the gas price take different routes and are
 *   checked separately — one goes through `position-history`, the other
 *   through `bot-pnl-updater`, and either can be wired while the other
 *   is not.
 */

"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const CHAIN_HISTORY_MODULE = "./nft-events-batch";

let reconstructEpochs;
const _origRequire = Module.prototype.require;

/** What each price path was asked for, per call. */
let seen;

const HISTORY = Object.freeze({
  mintDate: "2026-01-01T00:00:00Z",
  closeDate: "2026-01-02T00:00:00Z",
  closeBlockNumber: 27_000_123,
  entryValueUsd: 100,
  exitValueUsd: 95,
  feesEarnedUsd: 35,
  /*-
   *  Non-zero, so the gas branch actually converts. A zero wei amount
   *  needs no price and would skip the very call under test.
   */
  gasCostWei: "2000000000000000",
});

/** The batch-read stub the reconstructor requires. */
function chainHistoryStub() {
  return {
    scanChainNftEvents: async () => ({}),
    eventsFor: () => ({ collectEvents: [], dlEvents: [] }),
    prepareLifetimeRead: async () => ({}),
  };
}

before(() => {
  Module.prototype.require = function (id) {
    if (id === CHAIN_HISTORY_MODULE) return chainHistoryStub();
    if (id === "./position-history") {
      return {
        getPositionHistory: async (tokenId, opts) => {
          seen.history.push({ tokenId, refreshPrices: opts?.refreshPrices });
          return { ...HISTORY };
        },
      };
    }
    if (id === "./epoch-cache") {
      return {
        getCachedEpochs: () => null,
        setCachedEpochs: (_k, e) => seen.persisted.push(e),
      };
    }
    if (id === "./bot-pnl-updater") {
      return {
        actualGasCostUsd: async (wei, when) => {
          seen.gas.push({ wei: String(wei), when });
          return 0.03;
        },
      };
    }
    if (id === "./price-fetcher") {
      return {
        fetchTokenPriceUsd: async () => 1,
        withFreshPricesAllowed: async (fn) => fn(),
      };
    }
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/epoch-reconstructor")];
  ({ reconstructEpochs } = require("../src/epoch-reconstructor"));
});

after(() => {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/epoch-reconstructor")];
});

beforeEach(() => {
  seen = { history: [], gas: [], persisted: [] };
});

/** A tracker with no epochs, so a rebuild always has work to do. */
function tracker() {
  let data = { closedEpochs: [], liveEpoch: null };
  return {
    serialize: () => data,
    restore: (d) => {
      data = { ...data, ...d };
    },
    epochCount: () => data.closedEpochs.length,
  };
}

const EVENTS = [
  { oldTokenId: "50", newTokenId: "51" },
  { oldTokenId: "51", newTokenId: "52" },
];

/** Run a reconstruction with whatever request flags are set. */
async function run(extraState) {
  const t = tracker();
  await reconstructEpochs({
    pnlTracker: t,
    rebalanceEvents: EVENTS,
    botState: {
      activePosition: { token0: "0xA", token1: "0xB", fee: 3000 },
      walletAddress: "0xW",
      ...extraState,
    },
    updateBotState: () => {},
    fallbackPrices: { price0: 1, price1: 1 },
    readChainEvents: null,
  });
  return t;
}

describe("Re-scan Prices — the flag reaches both price paths", () => {
  it("asks the pair-token path to re-read when opted in", async () => {
    await run({ _needsEpochPriceRevalue: true });
    assert.ok(seen.history.length > 0, "history must be read at all");
    for (const call of seen.history)
      assert.equal(
        call.refreshPrices,
        true,
        `NFT ${call.tokenId} was read without the refresh`,
      );
  });

  it("asks the gas path to re-read when opted in", async () => {
    await run({ _needsEpochPriceRevalue: true });
    assert.ok(seen.gas.length > 0, "gas must be converted at all");
    for (const call of seen.gas) {
      assert.ok(call.when, "gas needs the moment it was spent");
      assert.equal(call.when.refresh, true, "gas was priced from cache");
    }
  });

  it("carries the close moment alongside the refresh", async () => {
    /*-
     *  Refreshing without the moment would re-read today's price and
     *  store it against a historical day — worse than the stale figure
     *  it replaced.
     */
    await run({ _needsEpochPriceRevalue: true });
    const [first] = seen.gas;
    assert.equal(first.when.blockNumber, 27_000_123);
    assert.equal(
      first.when.timestamp,
      Math.floor(Date.parse(HISTORY.closeDate) / 1000),
    );
  });

  it("leaves both paths alone on a plain Reload", async () => {
    /*-
     *  Reload rebuilds the history; the cached prices serve that
     *  correctly, so re-fetching would spend the quota to arrive at the
     *  same numbers. The two requests must stay distinguishable.
     */
    await run({ _needsEpochRebuild: true });
    for (const call of seen.history) assert.equal(call.refreshPrices, false);
    for (const call of seen.gas) assert.equal(call.when.refresh, false);
  });

  it("persists what it rebuilt", async () => {
    /*-
     *  A re-value that corrects the figures and never writes them back
     *  reverts on the next restart, and the operator watches the bad
     *  number return with no explanation.
     */
    await run({ _needsEpochPriceRevalue: true });
    assert.ok(
      seen.persisted.length > 0,
      "rebuilt epochs must reach the epoch cache",
    );
    /*-
     *  `_mergeAndPersist` hands the cache the closed-epoch ARRAY rather
     *  than the tracker's serialized state, so the written value is the
     *  epochs themselves.
     */
    const last = seen.persisted[seen.persisted.length - 1];
    const written = Array.isArray(last) ? last : last.closedEpochs || [];
    assert.equal(
      written.length,
      2,
      "an empty write would erase the history it just rebuilt",
    );
  });

  it("consumes the request so it does not fire on every later scan", async () => {
    /*-
     *  The state object goes in by reference: the reconstructor clears
     *  the flag on the caller's own object, and a copy would hide that.
     */
    const state = {
      activePosition: { token0: "0xA", token1: "0xB", fee: 3000 },
      walletAddress: "0xW",
      _needsEpochPriceRevalue: true,
    };
    await reconstructEpochs({
      pnlTracker: tracker(),
      rebalanceEvents: EVENTS,
      botState: state,
      updateBotState: () => {},
      fallbackPrices: { price0: 1, price1: 1 },
      readChainEvents: null,
    });
    assert.equal(state._needsEpochPriceRevalue, false, "one-shot request");
  });
});
