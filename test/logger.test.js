/**
 * @file test/logger.test.js
 * @description Tests for the shared `logCtx` helper and address
 *   abbreviation in `src/logger.js`.  Guards the canonical 6-field
 *   format used by every compound / rebalance / swap entry-point log.
 *   See the `feedback-log-full-context` memory for the rule.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { abbrAddr, logCtx, emojiId } = require("../src/logger");

test("abbrAddr renders 6-char head + ellipsis + 3-char tail", () => {
  const out = abbrAddr("0x4e448B2dD8fBB22e7e91b7D7eB9C5db5fa11161A");
  assert.equal(out, "0x4e44…61A");
});

test("abbrAddr returns '?' for missing input and short strings pass through", () => {
  assert.equal(abbrAddr(null), "?");
  assert.equal(abbrAddr(""), "?");
  assert.equal(abbrAddr("0x1234"), "0x1234"); // < 10 chars
});

test("logCtx emits all 6 fields in canonical order", () => {
  const out = logCtx({
    chain: "pulsechain",
    wallet: "0x4e448B2dD8fBB22e7e91b7D7eB9C5db5fa11161A",
    factory: "0xCC05bf80b3aF1a3Dc24D7Fc36b3A0bB6efA17f2",
    tokenId: "161234",
    symbol0: "PLSX",
    symbol1: "WPLS",
  });
  /*- Field order: chain wallet factory #tokenId emoji s0/s1.  Emoji
   *  body is non-deterministic per-build only in that it depends on the
   *  hash of the tokenId — the SAME tokenId always produces the SAME
   *  emoji, so we can substring-compare against `emojiId("161234")`. */
  const emoji = emojiId("161234");
  assert.equal(
    out,
    `pulsechain 0x4e44…61A 0xCC05…7f2 #161234 ${emoji} PLSX/WPLS`,
  );
});

test("logCtx falls back to '?' for missing fields and 'Token0/Token1' for missing symbols", () => {
  const out = logCtx({});
  /*- emojiId("?") wraps the 3-emoji fingerprint in ANSI reset codes; we
   *  don't assert its bytes, only that the surrounding fields render
   *  with their `?` / default-symbol fallbacks. */
  assert.match(out, /^\? \? \? #\? .* Token0\/Token1$/);
});

test("logCtx accepts the alternate `token0Symbol`/`token1Symbol` field names", () => {
  const out = logCtx({
    chain: "pulsechain",
    wallet: "0x4e448B2dD8fBB22e7e91b7D7eB9C5db5fa11161A",
    factory: "0xCC05bf80b3aF1a3Dc24D7Fc36b3A0bB6efA17f2",
    tokenId: "9",
    token0Symbol: "USDC",
    token1Symbol: "DAI",
  });
  assert.match(out, / USDC\/DAI$/);
});
