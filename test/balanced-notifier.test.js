/**
 * @file test/balanced-notifier.test.js
 * @description Unit tests for the balanced-band Telegram notifier.
 * Covers band boundaries, edge-trigger, cooldown, message format.
 * The maybeNotifyBalanced caller-side helper is exercised indirectly
 * via evaluateBalance + isBalanced; the price-fetch + dispatch path
 * is integration-level and depends on telegram + price-fetcher and is
 * intentionally NOT mocked here (would test the mocks).
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");

const {
  isBalanced,
  evaluateBalance,
  formatMessage,
  BALANCED_THRESHOLD,
  BALANCED_COOLDOWN_MS,
} = require("../src/lib/telegram-notifications/balanced-notifier");

const COOLDOWN = BALANCED_COOLDOWN_MS;

/*- Derive boundary inputs from BALANCED_THRESHOLD so the tests track the
 *  constant automatically.  Pick a small offset (10% of the threshold,
 *  floored at 0.001) so the "just inside" / "just outside" cases land
 *  comfortably on the right side of the boundary regardless of the
 *  threshold value, while staying well clear of float-epsilon issues at
 *  the band edge itself. */
const _OFFSET = Math.max(BALANCED_THRESHOLD * 0.1, 0.001);
const _IN_LOW = 0.5 - BALANCED_THRESHOLD + _OFFSET; // just inside lower edge
const _IN_HIGH = 0.5 + BALANCED_THRESHOLD - _OFFSET; // just inside upper edge
const _OUT_LOW = 0.5 - BALANCED_THRESHOLD - _OFFSET; // just outside lower edge
const _OUT_HIGH = 0.5 + BALANCED_THRESHOLD + _OFFSET; // just outside upper edge

/** Minimal stub position + poolState for evaluateBalance / formatMessage. */
function fixtures() {
  const position = {
    tokenId: "157149",
    token0Symbol: "WPLS",
    token1Symbol: "DAI",
    fee: 2500,
    tickLower: -200340,
    tickUpper: -198120,
  };
  const poolState = {
    decimals0: 18,
    decimals1: 18,
    price: 0.0000902,
    tick: -199230,
  };
  return { position, poolState };
}

describe("isBalanced", () => {
  it("returns null when total value is zero", () => {
    assert.strictEqual(isBalanced(0, 0), null);
  });

  it("returns null when total value is negative (shouldn't happen, but safe)", () => {
    assert.strictEqual(isBalanced(-1, -1), null);
  });

  it("flags 50/50 as in-band", () => {
    const r = isBalanced(100, 100);
    assert.strictEqual(r.inBand, true);
    assert.strictEqual(r.ratio0, 0.5);
  });

  it("flags ratio just inside lower edge as in-band", () => {
    const r = isBalanced(_IN_LOW * 100, (1 - _IN_LOW) * 100);
    assert.strictEqual(r.inBand, true);
  });

  it("flags ratio just inside upper edge as in-band", () => {
    const r = isBalanced(_IN_HIGH * 100, (1 - _IN_HIGH) * 100);
    assert.strictEqual(r.inBand, true);
  });

  it("flags ratio just outside lower edge as out-of-band", () => {
    const r = isBalanced(_OUT_LOW * 100, (1 - _OUT_LOW) * 100);
    assert.strictEqual(r.inBand, false);
  });

  it("flags ratio just outside upper edge as out-of-band", () => {
    const r = isBalanced(_OUT_HIGH * 100, (1 - _OUT_HIGH) * 100);
    assert.strictEqual(r.inBand, false);
  });

  it("BALANCED_THRESHOLD constant is a positive fraction below 0.5", () => {
    /*- Sanity bound only — the exact value lives in balanced-notifier.js
     *  and is intentionally code-only.  This guards against accidental
     *  sign flips or values that would make the band meaningless. */
    assert.ok(BALANCED_THRESHOLD > 0 && BALANCED_THRESHOLD < 0.5);
  });
});

describe("evaluateBalance", () => {
  function args(over) {
    const { position, poolState } = fixtures();
    return {
      position,
      poolState,
      amount0: 1000,
      amount1: 100, // v1 = 100 × $1
      price0: 0.1, // v0 = 1000 × 0.1 = $100  → ratio0 = 0.5
      price1: 1,
      lastInBand: false,
      lastNotifyTs: 0,
      /*- Default nowMs sits past one COOLDOWN window since epoch zero so
       *  a first-fire test (lastNotifyTs=0) trivially passes the cooldown
       *  gate.  Tests that exercise the cooldown boundary itself override
       *  this via the `over` arg. */
      nowMs: COOLDOWN + 1_000_000,
      ...over,
    };
  }

  it("out-of-band → out-of-band → no message", () => {
    const r = evaluateBalance(
      args({
        amount0: 1000,
        price0: 0.04, // v0 = 40 → ratio0 ≈ 0.286
        amount1: 100,
        price1: 1,
      }),
    );
    assert.strictEqual(r.message, null);
    assert.strictEqual(r.nextLastInBand, false);
  });

  it("out-of-band → in-band (first crossing) → fires + sets cooldown", () => {
    const r = evaluateBalance(args());
    assert.notStrictEqual(r.message, null);
    assert.strictEqual(r.nextLastInBand, true);
    assert.strictEqual(r.nextLastNotifyTs, COOLDOWN + 1_000_000);
  });

  it("in-band → in-band (no transition) → no message", () => {
    const r = evaluateBalance(args({ lastInBand: true, lastNotifyTs: 1 }));
    assert.strictEqual(r.message, null);
    assert.strictEqual(r.nextLastInBand, true);
    /*- timestamp unchanged when no message dispatched */
    assert.strictEqual(r.nextLastNotifyTs, 1);
  });

  it("in-band → out-of-band → state flips back", () => {
    const r = evaluateBalance(
      args({
        lastInBand: true,
        lastNotifyTs: 1_000_000,
        amount0: 1000,
        price0: 0.04,
      }),
    );
    assert.strictEqual(r.message, null);
    assert.strictEqual(r.nextLastInBand, false);
  });

  it("in-band → out-of-band → in-band within cooldown → suppressed", () => {
    /*- Simulate a fast oscillation: position exits the band, then
     *  re-enters before COOLDOWN has elapsed. The re-entry should be
     *  edge-detected (lastInBand=false) but the cooldown gate keeps the
     *  message suppressed. */
    const reEntryTs = 1_000_000 + COOLDOWN - 1; // 1 ms before cooldown lapses
    const r = evaluateBalance(
      args({
        lastInBand: false,
        lastNotifyTs: 1_000_000,
        nowMs: reEntryTs,
      }),
    );
    assert.strictEqual(r.message, null);
    /*- inBand state still updates so the next cycle sees the truth */
    assert.strictEqual(r.nextLastInBand, true);
    /*- cooldown timestamp NOT advanced because no message fired */
    assert.strictEqual(r.nextLastNotifyTs, 1_000_000);
  });

  it("in-band → out-of-band → in-band after cooldown → re-fires", () => {
    const reEntryTs = 1_000_000 + COOLDOWN; // exactly at cooldown boundary
    const r = evaluateBalance(
      args({
        lastInBand: false,
        lastNotifyTs: 1_000_000,
        nowMs: reEntryTs,
      }),
    );
    assert.notStrictEqual(r.message, null);
    assert.strictEqual(r.nextLastInBand, true);
    assert.strictEqual(r.nextLastNotifyTs, reEntryTs);
  });

  it("returns unchanged state when prices are unknown (v=0)", () => {
    const r = evaluateBalance(
      args({ amount0: 0, amount1: 0, price0: 0, price1: 0, lastInBand: true }),
    );
    assert.strictEqual(r.message, null);
    /*- carry over previous state — don't false-flip */
    assert.strictEqual(r.nextLastInBand, true);
  });
});

describe("formatMessage", () => {
  /*- The chain / provider / sym0 / sym1 / Fee Tier / Position lines are
   *  now built by `buildHeader` in `telegram-notifications/telegram.js`
   *  and are NOT part of this body — `notify()` prepends the header and
   *  a blank-line separator before this string.  These tests cover only
   *  the body (Holdings, Total, fees, P&L). */
  function fmtArgs() {
    const { position, poolState } = fixtures();
    return {
      position,
      poolState,
      amount0: 1234567.89,
      amount1: 115.4,
      price0: 0.00009,
      price1: 1,
      snap: { currentFeesUsd: 4.22, cumulativePnl: 18.45 },
    };
  }

  it("starts with the Holdings header (no chain/provider/Fee Tier in body)", () => {
    const m = formatMessage(fmtArgs());
    const lines = m.split("\n");
    assert.strictEqual(lines[0], "Holdings:");
    assert.ok(!m.includes("PulseChain"));
    assert.ok(!m.includes("Fee Tier"));
    assert.ok(!m.includes("Position: #"));
  });

  it("includes both token holdings with USD values using human names", () => {
    const m = formatMessage(fmtArgs());
    assert.match(m, /Holdings:/);
    /*- Each token's symbol gets a full line of its own (trailing colon),
     *  followed by an indented amount/USD line. */
    assert.match(m, /^ {2}WPLS:$/m);
    assert.match(m, /^ {2}DAI:$/m);
    assert.ok(!m.includes("T0:"), "must use human name, not T0");
    assert.ok(!m.includes("T1:"), "must use human name, not T1");
    assert.match(m, /Total value:/);
  });

  it("gives each Holdings token a full line (16-char trunc) with amount on next line", () => {
    const args = fmtArgs();
    args.position = {
      ...args.position,
      token0Symbol: "VeryLongTokenNameXYZ",
      token1Symbol: "AnotherLongSymbolABC",
    };
    const m = formatMessage(args);
    /*- Holdings section uses a wider 16-char budget than the compact
     *  12-char header pair built by `buildHeader`. */
    assert.match(m, /^ {2}VeryLongTokenNam:$/m);
    assert.match(m, /^ {2}AnotherLongSymbo:$/m);
    assert.match(m, /^ {2}VeryLongTokenNam:\n {4}.+\(\$/m);
  });

  it("omits range info entirely (no Range:, no Current price:, no ticks)", () => {
    const m = formatMessage(fmtArgs());
    assert.ok(!m.includes("Range:"));
    assert.ok(!m.includes("Current price:"));
    assert.ok(!m.includes("ticks"));
  });

  it("omits the ratio percent split (no Ratio: line)", () => {
    const m = formatMessage(fmtArgs());
    assert.ok(!m.includes("Ratio:"));
  });

  it("includes unclaimed fees and lifetime P&L when present", () => {
    const m = formatMessage(fmtArgs());
    assert.match(m, /Unclaimed fees: \$4\.22/);
    assert.match(m, /Lifetime P&L: \$18\.45/);
  });

  it("omits fees / P&L lines when snap fields are missing", () => {
    const m = formatMessage({ ...fmtArgs(), snap: undefined });
    assert.ok(!m.includes("Unclaimed fees:"));
    assert.ok(!m.includes("Lifetime P&L:"));
  });
});
