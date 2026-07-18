/**
 * @file test/slippage-resolver.test.js
 * @description Tests for `resolveSlippagePct` in
 *   `src/slippage-resolver.js`.
 *
 * The resolver picks the DESTINATION-token's per-token slippage
 * value.  When the destination side is unset, it returns the shipped
 * `slippagePct` default (0.75%).  The position's legacy saved
 * `slippagePct` is NOT consulted — after the single-slippage UI was
 * replaced by two per-token inputs, the legacy field is dormant.
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

  it("legacy slippagePct is IGNORED (dormant field, no longer consulted)", () => {
    /*- Even with slippagePct=5 saved, the resolver does not fall back
     *  to it.  This is the semantic shift when the single-slippage UI
     *  was replaced: opts.slippagePct is dormant. */
    const opts = { slippagePct: 5 };
    assert.strictEqual(resolveSlippagePct(opts, true), 0.75);
    assert.strictEqual(resolveSlippagePct(opts, false), 0.75);
  });

  it("handles null / undefined opts safely", () => {
    assert.strictEqual(resolveSlippagePct(null, true), 0.75);
    assert.strictEqual(resolveSlippagePct(undefined, false), 0.75);
  });
});
