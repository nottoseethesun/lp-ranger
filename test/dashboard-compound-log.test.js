/**
 * @file test/dashboard-compound-log.test.js
 * @description Tests for the compound Activity Log formatter.
 *
 * Regression history: compound executions (manual + auto) were never
 * surfaced in the Activity Log — only sound effects fired.  Users saw
 * no record of compounds in the log.  Fix: parallel block in
 * dashboard-data-events.js#_logCompound that calls formatCompoundEntry
 * when `lastCompoundAt` advances.  These tests guard the pure
 * formatter against regression.
 */

"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

describe("formatCompoundEntry", () => {
  let formatCompoundEntry;

  before(async () => {
    const mod = await import("../public/dashboard-compound-log.js");
    formatCompoundEntry = mod.formatCompoundEntry;
  });

  it("returns null when lastCompoundAt is missing", () => {
    assert.equal(formatCompoundEntry({}, "", null), null);
  });

  it("returns null when lastCompoundAt has not advanced", () => {
    const ts = "2026-04-26T10:00:00.000Z";
    const st = {
      lastCompoundAt: ts,
      compoundHistory: [{ timestamp: ts, usdValue: 5, txHash: "0xabc" }],
    };
    assert.equal(formatCompoundEntry(st, "", ts), null);
  });

  it("returns null when compoundHistory is empty", () => {
    const st = {
      lastCompoundAt: "2026-04-26T10:00:00.000Z",
      compoundHistory: [],
    };
    assert.equal(formatCompoundEntry(st, "", null), null);
  });

  it("formats an Auto compound with NFT id, USD, trigger, and txHash", () => {
    const st = {
      lastCompoundAt: "2026-04-26T10:00:00.000Z",
      compoundHistory: [
        {
          timestamp: "2026-04-26T10:00:00.000Z",
          usdValue: 12.345,
          trigger: "auto",
          txHash: "0xfeed",
        },
      ],
      position: { tokenId: 157149 },
    };
    const entry = formatCompoundEntry(st, " — pos ctx", null);
    assert.equal(entry.title, "Compound");
    assert.equal(entry.type, "fee");
    assert.equal(entry.txHash, "0xfeed");
    assert.equal(
      entry.detail,
      "NFT #157149 \u2014 $12.35 reinvested (Auto) — pos ctx",
    );
    assert.ok(entry.when instanceof Date);
    assert.equal(entry.when.toISOString(), "2026-04-26T10:00:00.000Z");
  });

  it("labels manual triggers as Manual", () => {
    const st = {
      lastCompoundAt: "2026-04-26T10:00:00.000Z",
      compoundHistory: [
        {
          timestamp: "2026-04-26T10:00:00.000Z",
          usdValue: 1,
          trigger: "manual",
          txHash: "0x1",
        },
      ],
      position: { tokenId: 1 },
    };
    const entry = formatCompoundEntry(st, "", null);
    assert.match(entry.detail, /\(Manual\)/);
  });

  it("uses '?' for tokenId when position is absent", () => {
    const st = {
      lastCompoundAt: "2026-04-26T10:00:00.000Z",
      compoundHistory: [
        {
          timestamp: "2026-04-26T10:00:00.000Z",
          usdValue: 0.5,
          trigger: "auto",
        },
      ],
    };
    const entry = formatCompoundEntry(st, "", null);
    assert.match(entry.detail, /^NFT #\?/);
  });

  it("falls back to 0 when usdValue is non-finite", () => {
    const st = {
      lastCompoundAt: "2026-04-26T10:00:00.000Z",
      compoundHistory: [
        {
          timestamp: "2026-04-26T10:00:00.000Z",
          usdValue: NaN,
          trigger: "auto",
        },
      ],
      position: { tokenId: 7 },
    };
    const entry = formatCompoundEntry(st, "", null);
    assert.match(entry.detail, /\$0\.00 reinvested/);
  });

  it("returns undefined `when` when the compound entry has no timestamp", () => {
    const st = {
      lastCompoundAt: "2026-04-26T10:00:00.000Z",
      compoundHistory: [{ usdValue: 1, trigger: "auto", txHash: "0x1" }],
      position: { tokenId: 1 },
    };
    const entry = formatCompoundEntry(st, "", null);
    assert.equal(entry.when, undefined);
  });

  it("emits the entry the first time lastCompoundAt is seen (prevSeen=null)", () => {
    const st = {
      lastCompoundAt: "2026-04-26T10:00:00.000Z",
      compoundHistory: [
        {
          timestamp: "2026-04-26T10:00:00.000Z",
          usdValue: 1,
          trigger: "auto",
          txHash: "0x1",
        },
      ],
      position: { tokenId: 1 },
    };
    assert.ok(formatCompoundEntry(st, "", null));
    assert.ok(formatCompoundEntry(st, "", undefined));
  });
});
