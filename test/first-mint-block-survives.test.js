/**
 * @file test/first-mint-block-survives.test.js
 * @description `firstMintBlockNumber` has to survive being copied
 *   between arrays.
 *
 * The event scanner hangs `firstMintTimestamp` and
 * `firstMintBlockNumber` on the events array as non-index properties.
 * `bot-recorder.js` then transplants the scan result into the bot's own
 * array with `events.length = 0; events.push(...found)` — which copies
 * the elements and silently drops both properties.
 *
 * That made a real fix a no-op. `chainScanFloor` uses
 * `firstMintBlockNumber` to bound the oldest NFT in a rebalance chain —
 * the one NFT no rebalance event can name a mint block for, and
 * therefore the most expensive scan of the run on a pool older than the
 * operator's first deposit. It worked on the two server-side paths,
 * which read the scanner's array directly, and did nothing at all on
 * the bot path, which is the one that costs hours.
 *
 * Non-index array properties are invisible to spread, `push(...)`,
 * `slice`, `map` and `[...arr]`, so this is easy to reintroduce. These
 * tests pin the mechanism rather than the symptom.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { chainScanFloor } = require("../src/nft-mint-blocks");

describe("the hazard itself", () => {
  it("spread and push really do drop a non-index property", () => {
    /*- Anchors the rule to observed behaviour rather than folklore, so
     *  the guards below are not cargo-culted. */
    const found = [{ a: 1 }];
    found.firstMintBlockNumber = 26_028_850;

    const viaSpread = [...found];
    assert.equal(viaSpread.firstMintBlockNumber, undefined);

    const viaPush = [];
    viaPush.push(...found);
    assert.equal(viaPush.firstMintBlockNumber, undefined);

    assert.equal(found.slice().firstMintBlockNumber, undefined);
  });

  it("and losing it silently downgrades the floor", () => {
    /*- The consequence, stated in the units that matter: the oldest NFT
     *  falls back to the pool's creation block. */
    const withProp = [];
    withProp.firstMintBlockNumber = 26_028_850;
    const poolCreation = 18_952_224;

    assert.equal(chainScanFloor(withProp, poolCreation), 26_028_850);
    assert.equal(chainScanFloor([...withProp], poolCreation), poolCreation);
  });
});

describe("bot-recorder carries the properties across the copy", () => {
  /*- Asserted against the source: the copy is three statements inside a
   *  long scan function with no seam to drive, and the failure mode is
   *  a missing line rather than a wrong value. */
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "bot-recorder.js"),
    "utf8",
  );

  it("re-attaches firstMintBlockNumber after the push", () => {
    assert.match(
      src,
      /events\.firstMintBlockNumber\s*=\s*found\.firstMintBlockNumber/,
      "push(...found) drops it; it has to be copied back explicitly",
    );
  });

  it("re-attaches firstMintTimestamp too", () => {
    /*- Same array, same loss.  It feeds the Lifetime Days figure. */
    assert.match(
      src,
      /events\.firstMintTimestamp\s*=\s*found\.firstMintTimestamp/,
    );
  });

  it("does the re-attach after the push, not before", () => {
    /*- Before the `events.length = 0` would be wiped; between the two
     *  statements would be wiped by the push. Order is load-bearing. */
    const push = src.indexOf("events.push(...found)");
    const attach = src.indexOf("events.firstMintBlockNumber = found.");
    assert.ok(push > 0 && attach > push, "re-attach must follow the push");
  });
});
