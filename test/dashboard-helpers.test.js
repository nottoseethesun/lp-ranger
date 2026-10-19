"use strict";

/**
 * @file test/dashboard-helpers.test.js
 * @description Tests for the pure helpers in `public/dashboard-helpers.js`.
 *   Uses jsdom (via `global-jsdom/register`) to populate browser globals,
 *   then imports the module directly and asserts against its real exports.
 *
 *   Scope: pins the pure, load-bearing helpers, and the one rule of
 *   `copyWithFeedback` that a quick second click depends on.  The other
 *   DOM-touching exports (`g`, `cloneTpl`, `act`, `copyElText`) and
 *   timezone-dependent formatters (`fmtDateTime`, `fmtReset`, `tzCode`)
 *   are intentionally out of scope — the former belong to a fuller
 *   DOM-driving suite, the latter would need timezone mocking to
 *   assert exact strings without becoming environment-sensitive.
 *
 *   Covered exports: emojiId, fmtMs, fmtCountdown, compositeKey,
 *   truncName, fmtNum, isFullRange, isFullRangeSpread, copyWithFeedback.
 */

require("global-jsdom/register");

const {
  describe,
  it,
  before,
  beforeEach,
  afterEach,
  mock,
} = require("node:test");
const assert = require("node:assert/strict");
const { learnUiSettings } = require("./helpers/ui-settings");

let helpers;

before(async () => {
  helpers = await import("../public/dashboard-helpers.js");
  // As at startup: the copy tick's length is a setting the server sends.
  await learnUiSettings();
});

// ── emojiId ────────────────────────────────────────────────────────────────

describe("emojiId()", () => {
  it("returns a 3-emoji fingerprint (not a byte-count of 3 — surrogate pairs)", () => {
    const out = helpers.emojiId("157149");
    assert.strictEqual(Array.from(out).length, 3);
  });

  it("is deterministic — same input, same output", () => {
    assert.strictEqual(helpers.emojiId("157149"), helpers.emojiId("157149"));
    assert.strictEqual(helpers.emojiId(""), helpers.emojiId(""));
  });

  it("produces DIFFERENT fingerprints for different inputs (probabilistic sanity)", () => {
    const ids = new Set(
      ["157149", "160123", "999999", "0xABCD", "pool-A"].map(helpers.emojiId),
    );
    assert.ok(
      ids.size >= 4,
      `expected ≥4 distinct fingerprints, got ${ids.size}`,
    );
  });
});

// ── fmtMs ──────────────────────────────────────────────────────────────────

describe("fmtMs()", () => {
  it("< 1 min: seconds only ('45s')", () => {
    assert.strictEqual(helpers.fmtMs(45_000), "45s");
  });

  it("whole minutes: minutes only ('3m')", () => {
    assert.strictEqual(helpers.fmtMs(3 * 60_000), "3m");
  });

  it("mixed: minutes + seconds ('3m 15s')", () => {
    assert.strictEqual(helpers.fmtMs(3 * 60_000 + 15_000), "3m 15s");
  });

  it("0 → '0s'", () => {
    assert.strictEqual(helpers.fmtMs(0), "0s");
  });
});

// ── fmtCountdown ───────────────────────────────────────────────────────────

describe("fmtCountdown()", () => {
  it("returns 'READY' when ms <= 0", () => {
    assert.strictEqual(helpers.fmtCountdown(0), "READY");
    assert.strictEqual(helpers.fmtCountdown(-1), "READY");
    assert.strictEqual(helpers.fmtCountdown(-999_999), "READY");
  });

  it("formats as zero-padded MM:SS", () => {
    assert.strictEqual(helpers.fmtCountdown(5_000), "00:05");
    assert.strictEqual(helpers.fmtCountdown(65_000), "01:05");
    assert.strictEqual(helpers.fmtCountdown(3 * 60_000 + 30_000), "03:30");
  });

  it("supports > 59 minutes (no hours segment — MM saturates upward)", () => {
    assert.strictEqual(helpers.fmtCountdown(90 * 60_000), "90:00");
  });
});

// ── compositeKey ───────────────────────────────────────────────────────────

describe("compositeKey()", () => {
  it("returns null when the chain is missing, rather than assuming one", () => {
    /*-
     *  A key on an assumed chain reaches no position on any other, so
     *  the chain is required like every other component.
     */
    assert.strictEqual(
      helpers.compositeKey(undefined, "0xWALLET", "0xCONTRACT", "157149"),
      null,
    );
    assert.strictEqual(
      helpers.compositeKey(null, "0xWALLET", "0xCONTRACT", "157149"),
      null,
    );
  });

  it("uses provided blockchain when given", () => {
    assert.strictEqual(
      helpers.compositeKey("solana", "0xWALLET", "0xCONTRACT", "157149"),
      "solana-0xWALLET-0xCONTRACT-157149",
    );
  });

  it("returns null when any of wallet / contract / tokenId is missing", () => {
    assert.strictEqual(
      helpers.compositeKey("pulsechain", null, "0xCONTRACT", "157149"),
      null,
    );
    assert.strictEqual(
      helpers.compositeKey("pulsechain", "0xWALLET", null, "157149"),
      null,
    );
    assert.strictEqual(
      helpers.compositeKey("pulsechain", "0xWALLET", "0xCONTRACT", null),
      null,
    );
    assert.strictEqual(helpers.compositeKey("pulsechain", "", "", ""), null);
  });
});

// ── truncName ──────────────────────────────────────────────────────────────

describe("truncName()", () => {
  it("returns the original when length ≤ max", () => {
    assert.strictEqual(helpers.truncName("HEX", 10), "HEX");
    assert.strictEqual(helpers.truncName("ExactlyTen", 10), "ExactlyTen");
  });

  it("truncates and appends ellipsis when longer than max", () => {
    assert.strictEqual(
      helpers.truncName("SuperLongTokenName", 10),
      "SuperLongT…",
    );
  });

  it("passes null / empty through unchanged", () => {
    assert.strictEqual(helpers.truncName(null, 5), null);
    assert.strictEqual(helpers.truncName("", 5), "");
  });
});

// ── fmtNum ─────────────────────────────────────────────────────────────────

describe("fmtNum()", () => {
  it("returns em-dash for non-finite", () => {
    assert.strictEqual(helpers.fmtNum(NaN), "—");
    assert.strictEqual(helpers.fmtNum(Infinity), "—");
    assert.strictEqual(helpers.fmtNum(-Infinity), "—");
  });

  it("returns '0' for zero", () => {
    assert.strictEqual(helpers.fmtNum(0), "0");
  });

  it("uses exponential for astronomical values (≥ 1e12)", () => {
    const out = helpers.fmtNum(1.5e15);
    assert.match(out, /^1\.5000e\+15$/);
  });

  it("formats sub-unit values with 6 significant figures (toPrecision(6))", () => {
    assert.strictEqual(helpers.fmtNum(0.123456789), "0.123457");
  });
});

// ── isFullRange ────────────────────────────────────────────────────────────

describe("isFullRange()", () => {
  it("is false for a normal price band", () => {
    assert.strictEqual(helpers.isFullRange(0.001, 1000), false);
  });

  it("is true when the lower bound is astronomically small (< 1e-30)", () => {
    assert.strictEqual(helpers.isFullRange(1e-40, 1000), true);
  });

  it("is true when the upper bound is astronomically large (> 1e30)", () => {
    assert.strictEqual(helpers.isFullRange(0.001, 1e40), true);
  });
});

// ── isFullRangeSpread ──────────────────────────────────────────────────────

describe("isFullRangeSpread()", () => {
  it("is true when spread ≥ 1_700_000", () => {
    assert.strictEqual(helpers.isFullRangeSpread(1_700_000), true);
    assert.strictEqual(helpers.isFullRangeSpread(1_774_544), true);
  });

  it("is false for typical narrow-position spreads", () => {
    assert.strictEqual(helpers.isFullRangeSpread(200), false);
    assert.strictEqual(helpers.isFullRangeSpread(10_000), false);
    assert.strictEqual(helpers.isFullRangeSpread(1_699_999), false);
  });

  it("is false for non-finite", () => {
    assert.strictEqual(helpers.isFullRangeSpread(NaN), false);
    assert.strictEqual(helpers.isFullRangeSpread(Infinity), false);
  });
});

// ── copyWithFeedback ───────────────────────────────────────────────────────

describe("copyWithFeedback()", () => {
  let copied;

  beforeEach(() => {
    copied = [];
    // jsdom has no clipboard; this stands in for the browser's.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t) => copied.push(t) },
      configurable: true,
    });
    /*-
     *  TEST-ONLY global swap: the feedback puts its icon back on a timer
     *  of its own, with no clock to hand it. Reset pristine after each
     *  case.
     */
    mock.timers.enable({ apis: ["setTimeout"] });
  });
  afterEach(() => {
    mock.timers.reset();
    delete navigator.clipboard;
  });

  it("puts the icon back after a second click inside the feedback window", () => {
    /*-
     *  The second click finds the checkmark showing. Taken as the icon
     *  to restore, it would be put back by the second timer after the
     *  first had restored the real icon, and stay for good.
     */
    const icon = document.createElement("span");
    icon.textContent = "⧉";
    helpers.copyWithFeedback(icon, "0xabc");
    assert.strictEqual(icon.textContent, "✓");
    helpers.copyWithFeedback(icon, "0xabc");
    mock.timers.tick(60_000);
    assert.strictEqual(icon.textContent, "⧉");
    assert.deepStrictEqual(copied, ["0xabc", "0xabc"], "both clicks copy");
  });
});
