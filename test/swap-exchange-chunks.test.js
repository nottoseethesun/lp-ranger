"use strict";

/**
 * @file test/swap-exchange-chunks.test.js
 * @description A swap split into chunks reports what its own transactions
 *   sent and received, added up over the chunks that landed
 *   (`exchange`, src/rebalancer-swap.js). A compound counts its fees by it
 *   (src/compounder.js), so a chunk whose exchange is unknown leaves the
 *   whole swap's unknown rather than reporting part of it as the whole.
 *
 *   The aggregator is stood in for: the full amount's price impact is too
 *   high, so the swap goes on to the chunks, each a call of the stand-in.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { readBotConfigDefaults } = require("../src/bot-config-defaults");

const AGG_PATH = require.resolve("../src/rebalancer-aggregator");
const SWAP_PATH = require.resolve("../src/rebalancer-swap");

/**
 * Load `swapIfNeeded` with the aggregator replaced by a stand-in.
 * @param {Function} aggregator  Called once per attempt with its params:
 *   the full amount first, then each chunk.
 * @returns {Function}
 */
function load(aggregator) {
  require.cache[AGG_PATH] = {
    id: AGG_PATH,
    filename: AGG_PATH,
    loaded: true,
    exports: {
      swapViaAggregator: (_s, _l, p) => aggregator(p),
      AGGREGATOR_LABEL: "Aggregator",
    },
  };
  delete require.cache[SWAP_PATH];
  return require(SWAP_PATH).swapIfNeeded;
}

/** The full amount's attempt, refused for its price impact. */
function fullAborts(p) {
  p._attempts.push({ label: p._attemptLabel, impactPct: 6 });
  throw Object.assign(new Error("impact 6% exceeds slippage"), {
    gasCostWei: 0n,
    isSwapImpactAbort: true,
  });
}

/** A chunk that landed, with what its own transaction moved. */
const chunk = (exchange) => ({
  amountOut: 10n,
  txHash: "0xchunk",
  gasCostWei: 1n,
  swapSources: "Aggregator",
  exchange,
});

const CHUNKS = BigInt(readBotConfigDefaults().swapChunkCount);
const PARAMS = { amountIn: 10n ** 18n, slippagePct: 1 };

describe("swapIfNeeded — a chunked swap's own exchange", () => {
  afterEach(() => {
    delete require.cache[AGG_PATH];
    delete require.cache[SWAP_PATH];
  });

  it("adds up what each chunk sent and received", async () => {
    let calls = 0;
    const swap = load((p) =>
      ++calls === 1 ? fullAborts(p) : chunk({ sent: 3n, received: 2n }),
    );
    const r = await swap({}, {}, PARAMS);
    assert.deepEqual(r.exchange, { sent: CHUNKS * 3n, received: CHUNKS * 2n });
  });

  it("leaves the exchange unknown when one chunk's is", async () => {
    let calls = 0;
    const swap = load((p) => {
      calls++;
      if (calls === 1) return fullAborts(p);
      return chunk(calls === 2 ? null : { sent: 3n, received: 2n });
    });
    const r = await swap({}, {}, PARAMS);
    assert.equal(r.exchange, null);
  });

  it("names nothing exchanged for a swap too small to send", async () => {
    const swap = load(() => assert.fail("no swap is sent"));
    const r = await swap({}, {}, { amountIn: 1n, slippagePct: 1 });
    assert.deepEqual(r.exchange, { sent: 0n, received: 0n });
  });
});
