/**
 * @file test/compounder-rebalance-fees.test.js
 * @description Tests that `classifyCompounds` correctly counts trading
 *   fees that were re-deposited via the rebalance flow (drain → mint),
 *   not just standalone auto/manual compounds.  Extracted from
 *   compounder.test.js for line-count compliance.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("classifyCompounds — fees from rebalance vs standalone", () => {
  /*-
   *  These tests exercise the classifier with no RPC calls by passing
   *  events that produce a zero-length compound list (rebalance-only
   *  history) — `_fetchCompoundGas` short-circuits when there is
   *  nothing to fetch.
   */
  const { classifyCompounds } = require("../src/compounder");

  it("counts fees re-deposited via rebalance (no standalone compounds)", async () => {
    /*-
     *  One drain (10 token0, 5 token1 of principal) → mint after.
     *  Collect afterwards extracts 11 token0 + 6 token1 (1 + 1 fees).
     *  No standalone IL events.  Expected fees = (11-10)+(6-5) priced at $1 each.
     */
    const nftEvents = {
      ilEvents: [
        // first IL = mint (skipped)
        { amount0: 10n, amount1: 5n, blockNumber: 100 },
        // second IL is the rebalance re-mint (drained-then-redeposit) — should be excluded by _filterRebalances
        { amount0: 11n, amount1: 6n, blockNumber: 200 },
      ],
      collectEvents: [{ amount0: 11n, amount1: 6n, blockNumber: 199 }],
      dlEvents: [
        { liquidity: 999n, amount0: 10n, amount1: 5n, blockNumber: 198 },
      ],
      ilLogsCount: 2,
    };
    const r = await classifyCompounds(nftEvents, {
      decimals0: 0,
      decimals1: 0,
      price0: 1,
      price1: 1,
      tokenId: "1",
    });
    // 0 standalone compounds (the second IL was a rebalance re-mint, filtered out)
    assert.equal(r.compounds.length, 0);
    // (11-10)*1 + (6-5)*1 = 2
    assert.equal(r.totalCompoundedUsd, 2);
  });

  it("returns 0 when collect total ≤ drain total (no fee surplus)", async () => {
    const nftEvents = {
      ilEvents: [{ amount0: 10n, amount1: 5n, blockNumber: 100 }],
      collectEvents: [{ amount0: 9n, amount1: 4n, blockNumber: 199 }],
      dlEvents: [
        { liquidity: 999n, amount0: 10n, amount1: 5n, blockNumber: 198 },
      ],
      ilLogsCount: 1,
    };
    const r = await classifyCompounds(nftEvents, {
      decimals0: 0,
      decimals1: 0,
      price0: 1,
      price1: 1,
      tokenId: "1",
    });
    assert.equal(r.totalCompoundedUsd, 0);
  });
});
