/**
 * @file test/dust.test.js
 * @description Unit tests for src/dust.js — inflation-resistant dust threshold.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// ── Mock price-fetcher so we don't hit the network ───────────────────────────

let _stubUnitPriceUsd = 4800;
const _priceFetcherStubPath = require.resolve("../src/price-fetcher");

function _installStub() {
  require.cache[_priceFetcherStubPath] = {
    id: _priceFetcherStubPath,
    filename: _priceFetcherStubPath,
    loaded: true,
    exports: {
      fetchDustUnitPriceUsd: async () => _stubUnitPriceUsd,
      _resetDustUnitPriceCache: () => {},
    },
  };
}

function _clearDustCache() {
  // Force re-require of dust.js so it picks up fresh config/stub.
  delete require.cache[require.resolve("../src/dust")];
}

beforeEach(() => {
  _stubUnitPriceUsd = 4800;
  _installStub();
  _clearDustCache();
});

afterEach(() => {
  delete require.cache[_priceFetcherStubPath];
  _clearDustCache();
});

describe("dust.DUST_THRESHOLD_UNITS (universal constant)", () => {
  it("is exported as a finite, positive number", () => {
    const { DUST_THRESHOLD_UNITS } = require("../src/dust");
    assert.ok(Number.isFinite(DUST_THRESHOLD_UNITS));
    assert.ok(DUST_THRESHOLD_UNITS > 0);
  });

  it("matches the value in app-config/static-tunables/dust-threshold.json", () => {
    // Bypass stubs to read the actual on-disk value.
    delete require.cache[_priceFetcherStubPath];
    _clearDustCache();
    const fs = require("fs");
    const path = require("path");
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "..",
          "app-config",
          "static-tunables",
          "dust-threshold.json",
        ),
        "utf8",
      ),
    );
    const { DUST_THRESHOLD_UNITS } = require("../src/dust");
    assert.strictEqual(DUST_THRESHOLD_UNITS, raw.thresholdUnits);
  });
});

describe("dust.getDustThresholdUsd", () => {
  it("multiplies units by USD/unit", async () => {
    _stubUnitPriceUsd = 4800;
    const { getDustThresholdUsd } = require("../src/dust");
    const res = await getDustThresholdUsd();
    // Default units = 1/4800, so threshold ≈ $1
    assert.ok(Math.abs(res.thresholdUsd - 1) < 1e-9);
    assert.strictEqual(res.usdPerUnit, 4800);
    assert.strictEqual(res.usedFallback, false);
  });

  it("uses fallback USD when unit price is 0", async () => {
    _stubUnitPriceUsd = 0;
    const {
      getDustThresholdUsd,
      _FALLBACK_THRESHOLD_USD,
    } = require("../src/dust");
    const res = await getDustThresholdUsd();
    assert.strictEqual(res.usedFallback, true);
    assert.strictEqual(res.thresholdUsd, _FALLBACK_THRESHOLD_USD);
  });
});

describe("dust.isDust", () => {
  it("returns true for non-finite inputs", async () => {
    const { isDust } = require("../src/dust");
    assert.strictEqual(await isDust(NaN), true);
    assert.strictEqual(await isDust(Infinity), true);
  });

  it("returns true below threshold and false above", async () => {
    _stubUnitPriceUsd = 4800; // threshold ≈ $1
    const { isDust } = require("../src/dust");
    assert.strictEqual(await isDust(0.5), true);
    assert.strictEqual(await isDust(-0.5), true); // sign ignored
    assert.strictEqual(await isDust(1.5), false);
    assert.strictEqual(await isDust(-1.5), false);
  });

  it("threshold scales with unit price", async () => {
    _stubUnitPriceUsd = 9600; // threshold ≈ $2
    const { isDust } = require("../src/dust");
    assert.strictEqual(await isDust(1.5), true);
    assert.strictEqual(await isDust(2.5), false);
  });
});
