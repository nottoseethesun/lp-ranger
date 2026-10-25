"use strict";

/**
 * @file test/aggregator-quote-impact.test.js
 * @description An aggregator quote that names no price impact is refused.
 *
 *   The impact is what holds a swap to the operator's slippage setting,
 *   so a quote whose `estimatedPriceImpact` is missing or unreadable is a
 *   failed quote: refused before any transaction, with a log line
 *   carrying the swap's full context, and the swap goes to the V3 router
 *   like any other aggregator failure. Read as zero instead, such a quote
 *   would pass the slippage check without being tested by it. A fresh
 *   quote after the approval is held to the same rule.
 *
 *   The aggregator side runs on the shared stage in
 *   `helpers/aggregator-harness.js`: real quote requests to a local http
 *   server, scripted answers.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const util = require("util");

const { _setSinkForTests } = require("../src/lib/log");
const { swapViaAggregator } = require("../src/lib/rebalancer-aggregator");
const { quoteImpactPct } = require("../src/lib/rebalancer-swap-impact");
const { swapIfNeeded } = require("../src/lib/rebalancer-swap");
const {
  ADDR,
  makeTx,
  buildMockEthersLib,
} = require("./helpers/rebalancer-mocks");
const {
  quote,
  state,
  installAggregatorStage,
  restoreAggregatorStage,
  dispatchWithApprovals,
  aggSigner,
  params,
  fixedOut,
} = require("./helpers/aggregator-harness");

// The six-field log context every swap line carries.
const CTX = "pulsechain 0xWALL…ET1 0xCC05…7f2 #100001 ⭐🌵🐎 T0/T1";

/**
 * Run `fn` and hand back every warning it logged, formatted, through the
 * logger's own seam rather than the global console.
 */
async function warningsOf(fn) {
  const lines = [];
  const restore = _setSinkForTests({
    warn: (...args) => lines.push(util.format(...args)),
  });
  try {
    await fn();
  } finally {
    restore();
  }
  return lines;
}

/** A quote with no impact figure at all: the field is absent. */
function quoteWithoutImpact() {
  const q = quote();
  delete q.estimatedPriceImpact;
  return q;
}

describe("quoteImpactPct", () => {
  it("reads a quote's impact as a number", () => {
    assert.equal(
      quoteImpactPct(
        quote({ estimatedPriceImpact: "1.25" }),
        CTX,
        "q",
        "A",
        "B",
      ),
      1.25,
    );
  });

  it("reads a negative impact, which a quote better than the pool's price has", () => {
    assert.equal(
      quoteImpactPct(
        quote({ estimatedPriceImpact: "-0.3" }),
        CTX,
        "q",
        "A",
        "B",
      ),
      -0.3,
    );
  });

  for (const [what, value] of [
    ["is missing", undefined],
    ["is null", null],
    ["is empty", ""],
    ["is not a number", "n/a"],
  ]) {
    it(`refuses a quote whose impact ${what}, naming the field in the log`, async () => {
      const q = quote({ estimatedPriceImpact: value });
      const lines = await warningsOf(async () => {
        assert.throws(
          () => quoteImpactPct(q, CTX, "quote", "T0", "T1"),
          /Aggregator quote refused: it names no price impact/,
        );
      });
      assert.equal(lines.length, 1, lines.join("\n"));
      assert.ok(lines[0].includes(CTX), lines[0]);
      assert.match(
        lines[0],
        /T0 -> T1 refused: the quote names no price impact/,
      );
      assert.match(lines[0], /estimatedPriceImpact=/);
    });
  }
});

describe("aggregator swap — a quote with no impact figure", () => {
  beforeEach(installAggregatorStage);
  afterEach(restoreAggregatorStage);

  it("refuses the first quote before approving or sending anything", async () => {
    state.quotes.push(quoteWithoutImpact());
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    await assert.rejects(
      swapViaAggregator(aggSigner(), lib, params({ logCtx: CTX }), fixedOut),
      /names no price impact/,
    );
    assert.equal(state.urls.length, 1, "asked for one quote, no fresh one");
    assert.equal(state.approvals.length, 0, "approved nothing");
    assert.equal(state.sent.length, 0, "sent no swap");
  });

  it("refuses the fresh quote after the approval, before sending the swap", async () => {
    state.quotes.push(quote(), quoteWithoutImpact());
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    const lines = await warningsOf(() =>
      assert.rejects(
        swapViaAggregator(aggSigner(), lib, params({ logCtx: CTX }), fixedOut),
        /names no price impact/,
      ),
    );
    assert.equal(state.urls.length, 2);
    assert.equal(state.sent.length, 0, "sent no swap");
    assert.ok(
      lines.some(
        (l) => l.includes(CTX) && l.includes("fresh quote after approval"),
      ),
      lines.join("\n"),
    );
  });
});

describe("swapIfNeeded — a quote with no impact figure falls back", () => {
  beforeEach(installAggregatorStage);
  afterEach(restoreAggregatorStage);

  it("goes to the V3 router without chunking, logging the swap's context", async () => {
    state.quotes.push(quoteWithoutImpact());
    const d = dispatchWithApprovals();
    let swapped = false;
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      balanceOf: async () => (swapped ? 9000n : 0n),
    };
    d[ADDR.router] = {
      exactInputSingle: Object.assign(
        async () => {
          swapped = true;
          return makeTx("0xs");
        },
        { staticCall: async (p) => p.amountIn },
      ),
    };
    let r;
    const lines = await warningsOf(async () => {
      r = await swapIfNeeded(
        aggSigner(),
        buildMockEthersLib({ contractDispatch: d }),
        {
          ...params({ logCtx: CTX }),
          swapRouterAddress: ADDR.router,
          fee: 3000,
          currentPrice: 1.0,
          decimalsIn: 18,
          decimalsOut: 18,
          isToken0To1: true,
          deadline: 9999999999n,
        },
      );
    });
    assert.ok(swapped, "the V3 router swapped");
    assert.ok(r.amountOut > 0n);
    assert.equal(state.urls.length, 1, "one quote, no chunked retries");
    assert.equal(state.sent.length, 0, "no aggregator swap was sent");
    assert.ok(
      lines.some(
        (l) =>
          l.includes(CTX) &&
          l.includes("aggregator failed (non-impact)") &&
          l.includes("names no price impact"),
      ),
      lines.join("\n"),
    );
  });
});
