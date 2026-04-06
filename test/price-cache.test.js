/**
 * @file test/price-cache.test.js
 * @description Tests for the historical price disk cache module.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  getHistoricalPrice,
  setHistoricalPrice,
  flushPriceCache,
  toUtcDayKey,
  _resetForTest,
  _CACHE_PATH,
} = require("../src/price-cache");

const _TMP = path.join(process.cwd(), "tmp", "test-price-cache-" + process.pid);

describe("price-cache", () => {
  // Production file protection handled by scripts/check.sh
  beforeEach(() => {
    _resetForTest();
    try {
      fs.unlinkSync(_CACHE_PATH);
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    _resetForTest();
  });

  it("returns null on cache miss", () => {
    const price = getHistoricalPrice(
      "pulsechain",
      "0xabc123",
      "2026-03-15T00:00",
    );
    assert.equal(price, null);
  });

  it("set + get round-trips correctly", () => {
    setHistoricalPrice("pulsechain", "0xABC123", "2026-03-15T00:00", 0.001302);
    const price = getHistoricalPrice(
      "pulsechain",
      "0xabc123",
      "2026-03-15T00:00",
    );
    assert.equal(price, 0.001302);
  });

  it("key is case-insensitive on token address", () => {
    setHistoricalPrice("pulsechain", "0xAbCdEf", "2026-03-15T00:00", 42.5);
    assert.equal(
      getHistoricalPrice("pulsechain", "0xABCDEF", "2026-03-15T00:00"),
      42.5,
    );
    assert.equal(
      getHistoricalPrice("pulsechain", "0xabcdef", "2026-03-15T00:00"),
      42.5,
    );
  });

  it("date-only lookup falls back to T00:00", () => {
    setHistoricalPrice("pulsechain", "0xabc", "2026-03-15T00:00", 1.5);
    const price = getHistoricalPrice("pulsechain", "0xabc", "2026-03-15");
    assert.equal(price, 1.5);
  });

  it("date-only lookup returns null when no T00:00 entry", () => {
    setHistoricalPrice("pulsechain", "0xabc", "2026-03-15T14:30", 1.5);
    const price = getHistoricalPrice("pulsechain", "0xabc", "2026-03-15");
    assert.equal(price, null);
  });

  it("flush writes to disk and survives reload", () => {
    setHistoricalPrice("pulsechain", "0xtoken1", "2026-04-01T00:00", 0.05);
    flushPriceCache();
    assert.ok(fs.existsSync(_CACHE_PATH));
    // Reset in-memory and reload from disk
    _resetForTest();
    const price = getHistoricalPrice(
      "pulsechain",
      "0xtoken1",
      "2026-04-01T00:00",
    );
    assert.equal(price, 0.05);
  });

  it("flush is a no-op when not dirty", () => {
    flushPriceCache();
    assert.ok(!fs.existsSync(_CACHE_PATH));
  });

  it("toUtcDayKey normalizes timestamps to UTC day T00:00", () => {
    // 2026-03-15 14:30:00 UTC
    const ts = Math.floor(new Date("2026-03-15T14:30:00Z").getTime() / 1000);
    assert.equal(toUtcDayKey(ts), "2026-03-15T00:00");
  });

  it("toUtcDayKey handles midnight exactly", () => {
    const ts = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);
    assert.equal(toUtcDayKey(ts), "2026-01-01T00:00");
  });

  it("different blockchains are separate cache entries", () => {
    setHistoricalPrice("pulsechain", "0xabc", "2026-03-15T00:00", 1.0);
    setHistoricalPrice("ethereum", "0xabc", "2026-03-15T00:00", 2.0);
    assert.equal(
      getHistoricalPrice("pulsechain", "0xabc", "2026-03-15T00:00"),
      1.0,
    );
    assert.equal(
      getHistoricalPrice("ethereum", "0xabc", "2026-03-15T00:00"),
      2.0,
    );
  });

  it("minute-level keys are preserved", () => {
    setHistoricalPrice("pulsechain", "0xabc", "2026-03-15T14:30", 3.0);
    setHistoricalPrice("pulsechain", "0xabc", "2026-03-15T14:31", 3.01);
    assert.equal(
      getHistoricalPrice("pulsechain", "0xabc", "2026-03-15T14:30"),
      3.0,
    );
    assert.equal(
      getHistoricalPrice("pulsechain", "0xabc", "2026-03-15T14:31"),
      3.01,
    );
  });
});

// ── gasNative in pnl-tracker ─────────────────────────────────────────────────

const { createPnlTracker } = require("../src/pnl-tracker");

describe("pnl-tracker gasNative", () => {
  it("addGas stores both USD and native amounts", () => {
    const t = createPnlTracker({ initialDeposit: 100 });
    t.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    t.addGas(0.5, 3059.26);
    const snap = t.snapshot(1);
    assert.equal(snap.totalGas, 0.5);
    assert.equal(snap.totalGasNative, 3059.26);
    assert.equal(snap.liveEpoch.gasNative, 3059.26);
  });

  it("closeEpoch accumulates gasNative", () => {
    const t = createPnlTracker({ initialDeposit: 100 });
    t.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    t.addGas(0.1, 500);
    t.closeEpoch({ exitValue: 98, gasCost: 0.2, gasNative: 1000 });
    const snap = t.snapshot(1);
    assert.equal(snap.totalGasNative, 1500);
  });

  it("daily P&L includes gasNative per day", () => {
    const t = createPnlTracker({ initialDeposit: 100 });
    t.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    t.addGas(0.3, 2000);
    const snap = t.snapshot(1);
    const today = snap.dailyPnl.find(
      (d) => d.date === new Date().toISOString().slice(0, 10),
    );
    assert.ok(today);
    assert.equal(today.gasNative, 2000);
  });

  it("closeEpoch without gasNative defaults to 0", () => {
    const t = createPnlTracker({ initialDeposit: 100 });
    t.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    t.closeEpoch({ exitValue: 99, gasCost: 0.1 });
    const snap = t.snapshot(1);
    assert.equal(snap.totalGasNative, 0);
    assert.equal(snap.closedEpochs[0].gasNative, 0);
  });

  it("snapshot returns totalGasNative in daily P&L entries", () => {
    const t = createPnlTracker({ initialDeposit: 100 });
    t.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    t.addGas(1.0, 5000);
    t.closeEpoch({ exitValue: 99, gasCost: 0.5, gasNative: 2000 });
    t.openEpoch({
      entryValue: 99,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    const snap = t.snapshot(1);
    assert.equal(snap.totalGasNative, 7000);
    assert.ok(snap.dailyPnl.length > 0);
  });

  it("openEpoch with gasCost includes gasNative in snapshot", () => {
    const t = createPnlTracker({ initialDeposit: 200 });
    t.openEpoch({
      entryValue: 200,
      entryPrice: 2,
      lowerPrice: 1.5,
      upperPrice: 2.5,
      gasCost: 0.3,
      gasNative: 1500,
    });
    const snap = t.snapshot(2);
    assert.equal(snap.liveEpoch.gasNative, 1500);
  });

  it("multiple epochs accumulate gasNative correctly", () => {
    const t = createPnlTracker({ initialDeposit: 100 });
    t.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    t.addGas(0.1, 100);
    t.closeEpoch({ exitValue: 99, gasCost: 0.2, gasNative: 200 });
    t.openEpoch({
      entryValue: 99,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    t.addGas(0.3, 300);
    t.closeEpoch({ exitValue: 98, gasCost: 0.4, gasNative: 400 });
    t.openEpoch({
      entryValue: 98,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    const snap = t.snapshot(1);
    // 100+200 + 300+400 = 1000 from closed, 0 from live
    assert.equal(snap.totalGasNative, 1000);
  });

  it("addGas with no native arg defaults gasNative to 0", () => {
    const t = createPnlTracker({ initialDeposit: 100 });
    t.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    t.addGas(0.5);
    const snap = t.snapshot(1);
    assert.equal(snap.totalGas, 0.5);
    assert.equal(snap.totalGasNative, 0);
  });
});
