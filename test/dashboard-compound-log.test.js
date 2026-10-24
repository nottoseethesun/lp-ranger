/**
 * @file test/dashboard-compound-log.test.js
 * @description Tests for the compound Activity Log formatter.
 *
 * Compound executions, manual and auto, reach the Activity Log through
 * `dashboard-data-events.js#_logCompound`, which calls
 * `formatCompoundEntry` when `lastCompoundAt` advances.  Without that
 * block a compound fires only its sound effect and leaves no record the
 * user can go back to.  These tests drive the pure formatter.
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
      "NFT #157149 \u2014 $usd 12.35 reinvested (Auto) — pos ctx",
    );
    assert.ok(entry.when instanceof Date);
    assert.equal(entry.when.toISOString(), "2026-04-26T10:00:00.000Z");
    // The record itself, for the entry's figures.
    assert.equal(entry.event, st.compoundHistory[0]);
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
    assert.match(entry.detail, /\$usd 0\.00 reinvested/);
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

  it("prefers event.tokenId over position.tokenId (rebalance chain)", () => {
    /*-
     *  Regression: historical compound rows in the Activity Log used
     *  the active position's tokenId, so a compound that occurred on a
     *  now-drained NFT showed up labeled with the current NFT id.  The
     *  formatter now prefers ev.tokenId when present so each row
     *  reflects the NFT the compound actually executed on.
     */
    const st = {
      lastCompoundAt: "2026-04-26T10:00:00.000Z",
      compoundHistory: [
        {
          timestamp: "2026-04-26T10:00:00.000Z",
          usdValue: 1.23,
          trigger: "auto",
          txHash: "0xrebal",
          tokenId: 158126,
        },
      ],
      position: { tokenId: 159124 },
    };
    const entry = formatCompoundEntry(st, "", null);
    assert.match(entry.detail, /^NFT #158126/);
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

describe("formatCompoundHistoryEntry", () => {
  let formatCompoundHistoryEntry;

  before(async () => {
    const mod = await import("../public/dashboard-compound-log.js");
    formatCompoundHistoryEntry = mod.formatCompoundHistoryEntry;
  });

  it("returns null for missing event", () => {
    assert.equal(formatCompoundHistoryEntry(null, "", 1), null);
    assert.equal(formatCompoundHistoryEntry(undefined, "", 1), null);
  });

  it("shows no marker for a compound rebuilt from the chain", () => {
    /*-
     *  A rebuild writes trigger `unknown`; a record written before that
     *  says `historical`. The chain does not say what started either.
     */
    for (const trigger of ["unknown", "historical"]) {
      const ev = {
        timestamp: "2026-04-04T21:15:15.000Z",
        usdValue: 2.29,
        trigger,
        txHash: "0xhist",
        tokenId: 158220,
      };
      const entry = formatCompoundHistoryEntry(ev, "", null);
      assert.equal(entry.title, "Compound");
      assert.equal(entry.type, "fee");
      assert.equal(entry.txHash, "0xhist");
      assert.equal(entry.detail, "NFT #158220 — $usd 2.29 reinvested");
      assert.equal(entry.when.toISOString(), "2026-04-04T21:15:15.000Z");
      assert.equal(entry.event, ev);
    }
  });

  it("labels auto trigger as Auto and manual as Manual", () => {
    const evAuto = {
      timestamp: "2026-04-26T10:00:00.000Z",
      usdValue: 1,
      trigger: "auto",
      tokenId: 1,
    };
    const evManual = {
      timestamp: "2026-04-26T10:00:00.000Z",
      usdValue: 1,
      trigger: "manual",
      tokenId: 1,
    };
    assert.match(
      formatCompoundHistoryEntry(evAuto, "", null).detail,
      /\(Auto\)/,
    );
    assert.match(
      formatCompoundHistoryEntry(evManual, "", null).detail,
      /\(Manual\)/,
    );
  });

  it("marks an amount at the prices of its compound's time (historical $usd)", () => {
    /*-
     *  A compound the bot makes is recorded with the prices its amount
     *  was worked out at. An entry a rebuild wrote carries none: its
     *  amount is at the prices of the rebuild, and shows no mark.
     */
    const ev = {
      timestamp: "2026-10-21T10:51:00.000Z",
      usdValue: 4.33,
      price0: 0.002,
      price1: 0.003,
      trigger: "auto",
      tokenId: 164910,
    };
    assert.equal(
      formatCompoundHistoryEntry(ev, "", null).detail,
      "NFT #164910 — $usd 4.33 (historical $usd) reinvested (Auto)",
    );
    const rebuilt = { ...ev, price0: undefined, price1: undefined };
    assert.equal(
      formatCompoundHistoryEntry(rebuilt, "", null).detail,
      "NFT #164910 — $usd 4.33 reinvested (Auto)",
    );
    // Both prices, or the amount is not known to be at that time's.
    for (const half of [{ price0: undefined }, { price1: Number.NaN }])
      assert.doesNotMatch(
        formatCompoundHistoryEntry({ ...ev, ...half }, "", null).detail,
        /historical/,
      );
  });

  it("shows no marker for a trigger it does not know, or none", () => {
    for (const trigger of ["bogus", undefined]) {
      const ev = {
        timestamp: "2026-04-26T10:00:00.000Z",
        usdValue: 1,
        trigger,
        tokenId: 1,
      };
      assert.equal(
        formatCompoundHistoryEntry(ev, "", null).detail,
        "NFT #1 — $usd 1.00 reinvested",
      );
    }
  });

  it("uses fallbackTokenId when the event lacks tokenId", () => {
    const ev = {
      timestamp: "2026-04-26T10:00:00.000Z",
      usdValue: 1,
      trigger: "historical",
    };
    const entry = formatCompoundHistoryEntry(ev, "", 99);
    assert.match(entry.detail, /^NFT #99/);
  });

  it("prefers ev.tokenId over fallbackTokenId", () => {
    const ev = {
      timestamp: "2026-04-26T10:00:00.000Z",
      usdValue: 1,
      trigger: "historical",
      tokenId: 158220,
    };
    const entry = formatCompoundHistoryEntry(ev, "", 99);
    assert.match(entry.detail, /^NFT #158220/);
  });

  it("falls back to '?' when both event and fallback tokenIds are absent", () => {
    const ev = {
      timestamp: "2026-04-26T10:00:00.000Z",
      usdValue: 1,
      trigger: "historical",
    };
    const entry = formatCompoundHistoryEntry(ev, "", null);
    assert.match(entry.detail, /^NFT #\?/);
  });

  it("returns $0.00 for non-finite usdValue", () => {
    const ev = {
      timestamp: "2026-04-26T10:00:00.000Z",
      usdValue: NaN,
      trigger: "historical",
      tokenId: 1,
    };
    const entry = formatCompoundHistoryEntry(ev, "", null);
    assert.match(entry.detail, /\$usd 0\.00 reinvested/);
  });

  it("returns undefined when for missing timestamp/txHash", () => {
    const ev = { usdValue: 1, trigger: "historical", tokenId: 1 };
    const entry = formatCompoundHistoryEntry(ev, "", null);
    assert.equal(entry.when, undefined);
    assert.equal(entry.txHash, undefined);
  });

  it("appends the position-context suffix", () => {
    const ev = {
      timestamp: "2026-04-26T10:00:00.000Z",
      usdValue: 1,
      trigger: "historical",
      tokenId: 1,
    };
    const entry = formatCompoundHistoryEntry(ev, "\nHEX/HEX", null);
    assert.ok(entry.detail.endsWith("\nHEX/HEX"));
  });
});
