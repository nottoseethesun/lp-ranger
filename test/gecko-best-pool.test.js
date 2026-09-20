/**
 * @file test/gecko-best-pool.test.js
 * @description `_pickBestPool` decides which pool a token's historical
 *   price is read from, and a wrong choice is not a missing number but a
 *   confident wrong one: read the quote side of PLSX/WPLS expecting WPLS
 *   and you get PLSX's price under WPLS's name.
 *
 *   The rule is deepest-first among the service's top ranked pools,
 *   skipping any that is not trading. Both halves matter and neither is
 *   implied by the other, so each is driven separately — and the
 *   fixtures are deliberately asymmetric, because a set where depth and
 *   volume agree cannot tell the rule from its opposite.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { _pickBestPool } = require("../src/gecko-pool-cache");

/** A pool as `_fetchTokenPoolsOnce` shapes one. */
function pool(name, liquidity, volume, side = "quote") {
  return { address: "0x" + name.toLowerCase(), name, liquidity, volume, side };
}

describe("_pickBestPool", () => {
  it("takes the deepest pool, not the first the service listed", () => {
    /*-
     *  The live ordering puts the highest-volume pool first, which is
     *  not the deepest — so returning `pools[0]` would pass a test built
     *  on a list that happens to be depth-sorted. This one is not.
     */
    const chosen = _pickBestPool([
      pool("USDC", 944_159, 389_199),
      pool("DAI", 933_207, 333_789),
      pool("PLSX", 2_441_604, 107_239),
    ]);
    assert.equal(chosen.name, "PLSX");
  });

  it("skips a deeper pool that is not trading", () => {
    /*-
     *  The whole point of the volume clause. Depth alone would choose
     *  the dead pool, whose candle for any given day does not exist.
     */
    const chosen = _pickBestPool([
      pool("DEAD", 9_000_000, 0),
      pool("LIVE", 100_000, 5_000),
    ]);
    assert.equal(chosen.name, "LIVE");
  });

  it("keeps skipping until it finds one that trades", () => {
    const chosen = _pickBestPool([
      pool("DEAD1", 9_000_000, 0),
      pool("DEAD2", 8_000_000, 0),
      pool("LIVE", 7_000, 1),
    ]);
    assert.equal(chosen.name, "LIVE");
  });

  it("drops a pool the token is on neither side of", () => {
    /*-
     *  The OHLCV endpoint answers for `base` or `quote` only. A pool
     *  where the token is neither cannot be read at all, so choosing it
     *  on depth would strand the lookup.
     */
    const chosen = _pickBestPool([
      pool("UNRELATED", 9_000_000, 500_000, null),
      pool("USABLE", 1_000, 1, "base"),
    ]);
    assert.equal(chosen.name, "USABLE");
  });

  it("considers only the top ten the service ranked", () => {
    /*-
     *  A deeper pool sitting at position eleven must not win: past the
     *  top ten the list stops being the service's view of the token's
     *  real market.
     */
    const top10 = Array.from({ length: 10 }, (_, i) =>
      pool("P" + i, 1_000 + i, 50),
    );
    const chosen = _pickBestPool([...top10, pool("DEEPEST", 9_000_000, 50)]);
    assert.equal(chosen.name, "P9", "an 11th pool must not be considered");
  });

  it("answers null when nothing in the list trades", () => {
    /*-
     *  Null is the caller's signal to fall through to another source.
     *  Returning the deepest dead pool would look like success and then
     *  yield an empty candle the caller cannot distinguish from a token
     *  that genuinely did not trade.
     */
    assert.equal(
      _pickBestPool([pool("A", 5_000, 0), pool("B", 1_000, 0)]),
      null,
    );
  });

  it("answers null for an empty list", () => {
    assert.equal(_pickBestPool([]), null);
  });

  it("ignores an entry with no address", () => {
    const chosen = _pickBestPool([
      { address: "", name: "X", liquidity: 9e9, volume: 9e9, side: "base" },
      pool("REAL", 10, 10),
    ]);
    assert.equal(chosen.name, "REAL");
  });
});
