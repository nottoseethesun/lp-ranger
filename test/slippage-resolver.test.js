/**
 * @file test/slippage-resolver.test.js
 * @description Tests for `resolveSlippagePct` in
 *   `src/slippage-resolver.js`.
 *
 * The resolver picks the DESTINATION-token's per-token slippage
 * value.  When the destination side is unset, it returns the shipped
 * `slippagePct` default (0.75%) from bot-config-defaults.json.
 *
 * It is the ONLY answer to the question, for every swap the app makes.
 * There used to be a second: a single `slippagePct` saved per position,
 * which rebalances ignored and compounds honoured — so one position
 * could swap at two different slippages depending on which move it was
 * making. That key is retired and both paths come here now.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { resolveSlippagePct } = require("../src/slippage-resolver");

describe("resolveSlippagePct — destination-token rule", () => {
  it("uses slippagePctToken1 for a token0→token1 swap (destination = token1)", () => {
    const opts = {
      slippagePctToken0: 2,
      slippagePctToken1: 0.5,
    };
    assert.strictEqual(resolveSlippagePct(opts, true), 0.5);
  });

  it("uses slippagePctToken0 for a token1→token0 swap (destination = token0)", () => {
    const opts = {
      slippagePctToken0: 2,
      slippagePctToken1: 0.5,
    };
    assert.strictEqual(resolveSlippagePct(opts, false), 2);
  });

  it("falls back to shipped 0.75% default when destination-side is unset", () => {
    /*- Token 0 side (2%) is set; Token 1 side is not.  A token0→token1
     *  swap (destination = token1) has no per-token value on that
     *  side, so the resolver returns the shipped default. */
    const opts = { slippagePctToken0: 2 };
    assert.strictEqual(resolveSlippagePct(opts, true), 0.75);
    assert.strictEqual(resolveSlippagePct(opts, false), 2);
  });

  it("uses shipped default on both sides when neither per-token field is set", () => {
    assert.strictEqual(resolveSlippagePct({}, true), 0.75);
    assert.strictEqual(resolveSlippagePct({}, false), 0.75);
  });

  it("null on the destination side counts as unset (shipped default)", () => {
    const opts = {
      slippagePctToken0: 2,
      slippagePctToken1: null,
    };
    assert.strictEqual(resolveSlippagePct(opts, true), 0.75);
    assert.strictEqual(resolveSlippagePct(opts, false), 2);
  });

  it("a retired single slippagePct is not consulted", () => {
    /*- A config file written before the key was retired can still
     *  carry it on disk until the next save. Even then it must not
     *  reach a swap: the two per-token settings are the whole of
     *  slippage. */
    const opts = { slippagePct: 5 };
    assert.strictEqual(resolveSlippagePct(opts, true), 0.75);
    assert.strictEqual(resolveSlippagePct(opts, false), 0.75);
  });

  it("handles null / undefined opts safely", () => {
    assert.strictEqual(resolveSlippagePct(null, true), 0.75);
    assert.strictEqual(resolveSlippagePct(undefined, false), 0.75);
  });
});
