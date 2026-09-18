/**
 * @file test/position-details-lifetime.test.js
 * @description `_resolveEntryValueCached` — how the unmanaged details
 *   path resolves a position's entry value from disk, without a chain
 *   baseline fetch.
 *
 *   The lifetime P&L helpers this file used to cover are gone with the
 *   walk that fed them: an unmanaged position shows no Lifetime panel,
 *   so nothing read them.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { _resolveEntryValueCached } = require("../src/position-details");

describe("_resolveEntryValueCached", () => {
  it("returns deposit when set", () => {
    const cfg = {
      positions: {
        k1: { initialDepositUsd: 500, hodlBaseline: { entryValue: 300 } },
      },
    };
    const { baseline, entryValue } = _resolveEntryValueCached(cfg, "k1");
    assert.strictEqual(entryValue, 500);
    assert.deepStrictEqual(baseline, { entryValue: 300 });
  });

  it("falls back to baseline entryValue when no deposit", () => {
    const cfg = {
      positions: {
        k1: { hodlBaseline: { entryValue: 300 } },
      },
    };
    const { entryValue } = _resolveEntryValueCached(cfg, "k1");
    assert.strictEqual(entryValue, 300);
  });

  it("returns 0 when no deposit and no baseline", () => {
    const cfg = { positions: {} };
    const { baseline, entryValue } = _resolveEntryValueCached(cfg, "k1");
    assert.strictEqual(entryValue, 0);
    assert.strictEqual(baseline, null);
  });

  it("returns 0 when deposit is 0 and no baseline entryValue", () => {
    const cfg = {
      positions: {
        k1: { initialDepositUsd: 0, hodlBaseline: { entryValue: 0 } },
      },
    };
    const { entryValue } = _resolveEntryValueCached(cfg, "k1");
    assert.strictEqual(entryValue, 0);
  });

  it("returns deposit when baseline is null", () => {
    const cfg = {
      positions: { k1: { initialDepositUsd: 200 } },
    };
    const { baseline, entryValue } = _resolveEntryValueCached(cfg, "k1");
    assert.strictEqual(entryValue, 200);
    assert.strictEqual(baseline, null);
  });
});
