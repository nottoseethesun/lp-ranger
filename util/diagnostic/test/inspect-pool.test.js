/**
 * @file util/diagnostic/test/inspect-pool.test.js
 * @description
 * Tests for the pure helpers exported from inspect-pool.js.  The CLI
 * `main()` is gated behind `require.main === module`, so requiring
 * this tool from a test does NOT run the CLI flow.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  fmtNum,
  fmtUsd,
  filterPositions,
  filterEpochByFragment,
} = require("../inspect-pool");

test("fmtNum — formats finite numbers with the requested precision", () => {
  assert.equal(fmtNum(3.14159, 2), "3.14");
  assert.equal(fmtNum(1, 4), "1.0000");
  assert.equal(fmtNum(0, 2), "0.00");
});

test("fmtNum — defaults to 4 decimals when not specified", () => {
  assert.equal(fmtNum(1.234567), "1.2346");
});

test("fmtNum — returns em-dash for missing/non-finite input", () => {
  assert.equal(fmtNum(null), "—");
  assert.equal(fmtNum(undefined), "—");
  assert.equal(fmtNum(NaN), "—");
  assert.equal(fmtNum(Infinity), "—");
  assert.equal(fmtNum("not a number"), "—");
});

test("fmtUsd — formats values with leading $ and 2 decimals", () => {
  assert.equal(fmtUsd(1234.5), "$1234.50");
  assert.equal(fmtUsd(0), "$0.00");
  assert.equal(fmtUsd(-1.5), "$-1.50");
});

test("fmtUsd — returns em-dash for missing/non-finite input", () => {
  assert.equal(fmtUsd(null), "—");
  assert.equal(fmtUsd(undefined), "—");
  assert.equal(fmtUsd(NaN), "—");
});

test("filterPositions — returns all positions when fragment is empty", () => {
  const positions = {
    "pulsechain-0xWALLET-0xPM-100": { tokenId: 100 },
    "pulsechain-0xWALLET-0xPM-200": { tokenId: 200 },
  };
  assert.deepEqual(filterPositions(positions, ""), positions);
  assert.deepEqual(filterPositions(positions, null), positions);
});

test("filterPositions — case-insensitive substring match on the key", () => {
  const positions = {
    "pulsechain-0xWALLET-0xPM-159250": { tokenId: 159250 },
    "pulsechain-0xWALLET-0xPM-200": { tokenId: 200 },
    "pulsechain-0xOTHER-0xPM-300": { tokenId: 300 },
  };
  const out = filterPositions(positions, "159250");
  assert.equal(Object.keys(out).length, 1);
  assert.ok(out["pulsechain-0xWALLET-0xPM-159250"]);

  const wallet = filterPositions(positions, "0xwallet");
  assert.equal(Object.keys(wallet).length, 2);
});

test("filterPositions — returns an empty object on no match", () => {
  const positions = { "pulsechain-0xA-0xB-1": {} };
  assert.deepEqual(filterPositions(positions, "zzz"), {});
});

test("filterEpochByFragment — filters epoch cache by substring", () => {
  const cache = {
    "pulsechain.0xPM.0xWALLET.0xT0.0xT1.10000": { cachedAt: "now" },
    "pulsechain.0xPM.0xWALLET.0xOTHER.0xT1.500": { cachedAt: "now" },
  };
  const out = filterEpochByFragment(cache, "0xt0");
  assert.equal(Object.keys(out).length, 1);
  assert.ok(out["pulsechain.0xPM.0xWALLET.0xT0.0xT1.10000"]);
});

test("filterEpochByFragment — empty fragment returns whole cache", () => {
  const cache = { foo: 1, bar: 2 };
  assert.deepEqual(filterEpochByFragment(cache, ""), cache);
});
