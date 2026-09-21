"use strict";

/**
 * @file test/slippage-one-answer.test.js
 * @description Pins that slippage has ONE answer for a given swap, and
 *   that every path in the app asks for it the same way.
 *
 *   The defect this guards against was live: a position's slippage was
 *   three settings, not two. Alongside `slippagePctToken0` and
 *   `slippagePctToken1` there was a single `slippagePct` saved per
 *   position — the leftover of the Slippage row before it was split.
 *   A rebalance ignored it and used the per-token values; a compound
 *   read it and used it. So the same position, swapping the same pair
 *   through the same router, applied one slippage when it rebalanced
 *   and a different one when it compounded, and nothing on the
 *   dashboard said so.
 *
 *   These tests work on the seams rather than through a live swap:
 *   `buildRebalanceOpts` and `buildCompoundOpts` are what hand the
 *   settings down, and `resolveSlippagePct` is the one function that
 *   turns them into a figure. If a future change re-introduces a
 *   second source, one of these fails.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { resolveSlippagePct } = require("../src/slippage-resolver");
const {
  POSITION_KEYS,
  RETIRED_POSITION_KEYS,
} = require("../src/bot-config-keys");

describe("slippage is two settings, and no more", () => {
  it("keeps only the two per-token keys as position settings", () => {
    const slippageKeys = POSITION_KEYS.filter((k) => /^slippage/i.test(k));
    assert.deepEqual(slippageKeys.sort(), [
      "slippagePctToken0",
      "slippagePctToken1",
    ]);
  });

  it("retires the single per-position slippagePct", () => {
    /*- Retired rather than merely unlisted, so it is dropped from
     *  bot-config.json on the next load instead of sitting there
     *  looking like a setting. */
    assert.ok(RETIRED_POSITION_KEYS.includes("slippagePct"));
  });
});

describe("every swap resolves slippage the same way", () => {
  /*- The figures a position might have saved, and what each swap
   *  direction must come out at. token0 → token1 takes token1's
   *  setting; token1 → token0 takes token0's. */
  const SAVED = { slippagePctToken0: 3, slippagePctToken1: 9 };

  it("gives the destination token's figure, whoever is asking", () => {
    assert.strictEqual(resolveSlippagePct(SAVED, true), 9);
    assert.strictEqual(resolveSlippagePct(SAVED, false), 3);
  });

  it("is not swayed by a stale single slippagePct riding along", () => {
    /*- An un-migrated config can still carry it in the same object the
     *  opts are built from. It must change nothing. */
    const withStale = { ...SAVED, slippagePct: 0.2 };
    assert.strictEqual(resolveSlippagePct(withStale, true), 9);
    assert.strictEqual(resolveSlippagePct(withStale, false), 3);
  });
});

describe("the compound path carries the same settings the rebalance does", () => {
  /*- Read as source rather than executed: building real compound opts
   *  needs a signer, a pool state and a priced position. What matters
   *  is which keys each builder reads and hands down, and that is a
   *  property of the text. */
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (f) =>
    fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");

  it("builds compound opts from the two per-token keys", () => {
    const src = read("bot-cycle-compound.js");
    assert.match(src, /slippagePctToken0/);
    assert.match(src, /slippagePctToken1/);
  });

  it("reads no single slippagePct in either opts builder", () => {
    for (const f of ["bot-cycle-compound.js", "bot-cycle-opts.js"]) {
      const src = read(f);
      assert.ok(
        !/_getConfig\?\.\("slippagePct"\)/.test(src),
        `${f} still reads the retired single slippagePct`,
      );
    }
  });

  it("sends the compound swap through resolveSlippagePct", () => {
    /*- The compound swap used to take `opts.slippagePct ?? default`,
     *  which is the fork this whole file exists to prevent. */
    const src = read("compounder-swap.js");
    assert.match(src, /resolveSlippagePct\(opts, is0to1\)/);
    assert.ok(
      !/opts\.slippagePct\b/.test(src),
      "compounder-swap still reads a single slippagePct off its opts",
    );
  });
});
