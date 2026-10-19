"use strict";

/**
 * @file test/range-override.test.js
 * @description Tests for `resolveRangeOverrideEnabled` in
 * `src/range-override.js` — the sole decider of whether a position's
 * saved Range settings apply on the next rebalance.
 *
 * The rule has three tiers and each one exists for a concrete reason:
 *
 *   1. An explicit boolean wins.  The user touched the "No Override"
 *      toggle, so their choice is authoritative even when it disagrees
 *      with what else is on the slot.
 *   2. A slot already carrying Range settings resolves to `true`.  Those
 *      slots predate the toggle; without this tier, shipping the toggle
 *      would silently stop applying settings that live positions rely
 *      on right now.
 *   3. Otherwise the shipped default — `false`, i.e. "No Override" — so
 *      a position seen for the first time re-uses its existing on-chain
 *      range rather than reshaping it.
 *
 * Tier 2 is the one a future refactor is most likely to drop, because it
 * looks redundant next to the shipped default.  It isn't.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveRangeOverrideEnabled,
  resolveRebalanceOffsetPct,
  RANGE_OVERRIDE_KEYS,
} = require("../src/range-override");
const { CENTERED_OFFSET_PCT } = require("../src/centered-offset");
const { loadShippedDefaults } = require("../src/load-merged-defaults");

/*- The shipped default read the same way the SUT reads it, so this
 *  suite asserts against the JSON rather than a second literal (see
 *  feedback_one_literal_per_shipped_default). */
const SHIPPED_DEFAULT = loadShippedDefaults(
  "bot-config-defaults.json",
).rangeOverrideEnabled;

describe("resolveRangeOverrideEnabled — explicit toggle wins", () => {
  it("returns true when the key is explicitly true", () => {
    assert.equal(
      resolveRangeOverrideEnabled({ rangeOverrideEnabled: true }),
      true,
    );
  });

  it("returns false when the key is explicitly false", () => {
    assert.equal(
      resolveRangeOverrideEnabled({ rangeOverrideEnabled: false }),
      false,
    );
  });

  it("an explicit false beats saved Range settings on the same slot", () => {
    /*- The whole point of making "No Override" a toggle rather than a
     *  button: the user's saved values stay on disk, ignored, so
     *  flipping the toggle back restores them.  If the derive tier ever
     *  ran ahead of the explicit key, turning the toggle on would
     *  appear to do nothing for exactly the users who have settings to
     *  suppress. */
    const cfg = {
      rangeOverrideEnabled: false,
      rebalanceRangeWidthPct: 80,
      fullRangeRebalanceEnabled: true,
      offsetToken0Pct: 70,
    };
    assert.equal(resolveRangeOverrideEnabled(cfg), false);
  });

  it("an explicit true is honoured on an otherwise-empty slot", () => {
    assert.equal(
      resolveRangeOverrideEnabled({ rangeOverrideEnabled: true }),
      true,
    );
  });

  it("ignores non-boolean values and falls through to the derive tier", () => {
    /*- A hand-edited bot-config.json carrying a string must not be
     *  treated as a decision.  Empty slot otherwise → shipped default. */
    assert.equal(
      resolveRangeOverrideEnabled({ rangeOverrideEnabled: "true" }),
      SHIPPED_DEFAULT,
    );
    assert.equal(
      resolveRangeOverrideEnabled({ rangeOverrideEnabled: 1 }),
      SHIPPED_DEFAULT,
    );
    assert.equal(
      resolveRangeOverrideEnabled({ rangeOverrideEnabled: null }),
      SHIPPED_DEFAULT,
    );
  });
});

describe("resolveRangeOverrideEnabled — pre-toggle slots keep working", () => {
  it("derives true from a saved Price Range Extension", () => {
    assert.equal(
      resolveRangeOverrideEnabled({ rebalanceRangeWidthPct: 80 }),
      true,
    );
  });

  it("derives true from a saved Position Offset", () => {
    assert.equal(resolveRangeOverrideEnabled({ offsetToken0Pct: 60 }), true);
  });

  it("derives true from a centred Position Offset saved explicitly", () => {
    /*- 50 is the shipped default, so this changes nothing at rebalance
     *  time — but the user did save it, and preserving today's exact
     *  behaviour on upgrade matters more than tidiness. */
    assert.equal(resolveRangeOverrideEnabled({ offsetToken0Pct: 50 }), true);
  });

  it("derives true from fullRangeRebalanceEnabled === true", () => {
    assert.equal(
      resolveRangeOverrideEnabled({ fullRangeRebalanceEnabled: true }),
      true,
    );
  });

  it("does NOT derive true from fullRangeRebalanceEnabled === false", () => {
    /*- An explicitly-saved false means the user unchecked the box.  That
     *  is the absence of an override, not the presence of one. */
    assert.equal(
      resolveRangeOverrideEnabled({ fullRangeRebalanceEnabled: false }),
      SHIPPED_DEFAULT,
    );
  });

  it("ignores null-valued Range keys left behind on a slot", () => {
    const cfg = {
      rebalanceRangeWidthPct: null,
      offsetToken0Pct: null,
      fullRangeRebalanceEnabled: null,
    };
    assert.equal(resolveRangeOverrideEnabled(cfg), SHIPPED_DEFAULT);
  });

  it("is not fooled by unrelated settings on the slot", () => {
    /*- Only the three Range keys count.  A position with slippage and a
     *  status saved but no Range settings is still a fresh Range slot. */
    const cfg = {
      status: "running",
      slippagePct: 1.5,
      maxRebalancesPerDay: 3,
      autoCompoundEnabled: true,
    };
    assert.equal(resolveRangeOverrideEnabled(cfg), SHIPPED_DEFAULT);
  });
});

describe("resolveRangeOverrideEnabled — new positions", () => {
  it("an empty slot resolves to the shipped default", () => {
    assert.equal(resolveRangeOverrideEnabled({}), SHIPPED_DEFAULT);
  });

  it("the shipped default is 'No Override'", () => {
    /*- The user's requirement: any position that is the first of its
     *  kind defaults to No Override, in the actual application state and
     *  not merely in the UI. */
    assert.equal(SHIPPED_DEFAULT, false);
    assert.equal(resolveRangeOverrideEnabled({}), false);
  });

  it("handles a missing slot without throwing", () => {
    assert.equal(resolveRangeOverrideEnabled(undefined), SHIPPED_DEFAULT);
    assert.equal(resolveRangeOverrideEnabled(null), SHIPPED_DEFAULT);
  });
});

describe("resolveRebalanceOffsetPct — the offset the next rebalance uses", () => {
  /*-
   *  An operator's default of 70, off the shipped centre, so a rule that
   *  centred whenever nothing was saved could not pass.
   */
  const DEFAULTS = { offsetToken0Pct: 70 };

  it("is the install's default when the position saved none", () => {
    assert.equal(
      resolveRebalanceOffsetPct({ rangeOverrideEnabled: true }, DEFAULTS),
      70,
    );
  });

  it("is the position's own when it saved one", () => {
    assert.equal(
      resolveRebalanceOffsetPct(
        { rangeOverrideEnabled: true, offsetToken0Pct: 30 },
        DEFAULTS,
      ),
      30,
    );
  });

  it("is centred under No Override, whatever is saved or defaulted", () => {
    assert.equal(
      resolveRebalanceOffsetPct(
        { rangeOverrideEnabled: false, offsetToken0Pct: 30 },
        DEFAULTS,
      ),
      CENTERED_OFFSET_PCT,
    );
  });
});

describe("RANGE_OVERRIDE_KEYS", () => {
  it("names exactly the three settings the toggle governs", () => {
    /*- Guard against a fourth Range setting being added to the UI
     *  without being added here — it would then apply while the badge
     *  claimed the existing range was being re-used. */
    assert.deepEqual(RANGE_OVERRIDE_KEYS, [
      "rebalanceRangeWidthPct",
      "fullRangeRebalanceEnabled",
      "offsetToken0Pct",
    ]);
  });
});
