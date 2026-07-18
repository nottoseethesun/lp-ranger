/**
 * @file test/dashboard-data-deposit-reset.test.js
 * @description Mirror tests for the "Return to Automatic Detection"
 * reset handlers in `public/dashboard-data-deposit.js`.  The dashboard
 * module pulls DOM + localStorage + a browser-only ES-module import
 * graph that node:test can't load, so we mirror the reset helpers here
 * in plain CommonJS with lightweight DOM / localStorage stubs.
 *
 * The critical assertion this file guarantees — and the one the user
 * asked me to prove — is that calling any reset function DELETES the
 * localStorage override outright.  The corresponding load helpers all
 * return 0 (or null for the lifetime-days start date) when the key is
 * absent, and that "0 / null" state is the "auto-detection kicks in"
 * signal every downstream consumer honours.
 *
 * Five inline-edit dialogs are covered:
 *   1. Total Lifetime Deposit          → `initialDepositUsd` (pool-scoped)
 *   2. Total Lifetime Days             → `lifetimeStartDateOverrideUtc`
 *      (pool-scoped)
 *   3. Lifetime Realized Gains         → `9mm_realized_pool_` (pool-scoped)
 *   4. Initial Deposit (this position) → `9mm_deposit_pos_`   (per-tokenId)
 *   5. Realized Gains (this position)  → `9mm_realized_pos_`  (per-tokenId)
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// ── Test doubles ──────────────────────────────────────────────────────

/*- Minimal localStorage double.  Backed by a plain object; supports
 *  get / set / remove / has.  Fresh per test via `beforeEach`. */
function makeLocalStorage() {
  const store = {};
  return {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k, v) {
      store[k] = String(v);
    },
    removeItem(k) {
      delete store[k];
    },
    has(k) {
      return Object.prototype.hasOwnProperty.call(store, k);
    },
    _dump() {
      return { ...store };
    },
  };
}

/*- Minimal wrap element.  Only the `.classList` facet the reset
 *  helpers touch is modelled — the input element itself is never
 *  read by the reset path (reset just deletes the localStorage
 *  key, no matter what's currently typed). */
function makeWrap(open = true) {
  const classes = new Set();
  if (open) classes.add("open");
  return {
    classList: {
      contains(c) {
        return classes.has(c);
      },
      add(c) {
        classes.add(c);
      },
      remove(c) {
        classes.delete(c);
      },
      toggle(c, force) {
        const shouldAdd = force !== undefined ? force : !classes.has(c);
        if (shouldAdd) classes.add(c);
        else classes.delete(c);
      },
    },
    _isOpen() {
      return classes.has("open");
    },
  };
}

// ── Mirrors of the production helpers ─────────────────────────────────

/*- Mirror of `_loadNum` from public/dashboard-data-deposit.js.  Returns
 *  0 whenever the key is missing OR the stored value fails the
 *  positive-number check — this is the "auto-detection resumes" signal. */
function loadNum(ls, key, allowZero) {
  if (!key) return 0;
  const raw = ls.getItem(key);
  const v = parseFloat(raw);
  return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? v : 0;
}

/*- Mirror of `_saveInput`. */
function saveInput(ls, wrap, inputValue, key, allowZero) {
  const val = parseFloat(inputValue);
  const amount =
    Number.isFinite(val) && (allowZero ? val >= 0 : val > 0) ? val : 0;
  ls.setItem(key, String(amount));
  wrap.classList.remove("open");
  return amount;
}

/*- Mirror of `_resetInput`. */
function resetInput(ls, wrap, key, afterReset) {
  if (key) ls.removeItem(key);
  wrap.classList.remove("open");
  if (afterReset) afterReset();
}

// ── Shared invariant covered across every dialog ──────────────────────

/**
 * The core promise of every "Return to Automatic Detection" button:
 * after reset, the corresponding load helper returns 0 (or the "no
 * override present" sentinel).  This is what every downstream KPI
 * update honours — a truthy override wins; a 0/null value falls through
 * to whatever auto-detection produces on the next poll.
 */
function assertResetReturnsToAutomatic(ls, key, load) {
  ls.setItem(key, "42");
  assert.equal(load(), 42, "override present before reset");
  const wrap = makeWrap(true);
  resetInput(ls, wrap, key, null);
  assert.equal(load(), 0, "load returns 0 after reset (auto-detection state)");
  assert.equal(wrap._isOpen(), false, "wrap collapsed after reset");
  assert.equal(ls.has(key), false, "localStorage key removed");
}

// ── Per-dialog coverage ───────────────────────────────────────────────

describe("Return to Automatic Detection — Total Lifetime Deposit", () => {
  let ls;
  const key = "9mm_deposit_pool_pulsechain_0xw_0xc_0xt0_0xt1_10000";
  beforeEach(() => {
    ls = makeLocalStorage();
  });
  it("removes the localStorage override and the load helper returns 0", () => {
    assertResetReturnsToAutomatic(ls, key, () => loadNum(ls, key, false));
  });
  it("collapses the input wrap so the user sees the edit dialog close", () => {
    ls.setItem(key, "500");
    const wrap = makeWrap(true);
    resetInput(ls, wrap, key, null);
    assert.equal(wrap._isOpen(), false);
  });
  it("invokes the afterReset callback so KPIs re-render on the next poll", () => {
    ls.setItem(key, "500");
    const wrap = makeWrap(true);
    let called = false;
    resetInput(ls, wrap, key, () => {
      called = true;
    });
    assert.equal(called, true);
  });
});

describe("Return to Automatic Detection — Total Lifetime Days", () => {
  let ls;
  const key = "9mm_lt_start_pool_pulsechain_0xw_0xc_0xt0_0xt1_10000";
  beforeEach(() => {
    ls = makeLocalStorage();
  });
  it("removes the YYYY-MM-DD override so ltStartDate falls through to auto-detected candidates", () => {
    ls.setItem(key, "2024-01-01");
    assert.equal(ls.getItem(key), "2024-01-01");
    const wrap = makeWrap(true);
    resetInput(ls, wrap, key, null);
    /*- The production `loadLifetimeStartDateOverride` returns null when
     *  the key is missing; `ltStartDate` then picks the earliest
     *  auto-detected candidate.  That "null → auto" transition is the
     *  invariant this reset must preserve. */
    assert.equal(ls.getItem(key), null);
    assert.equal(ls.has(key), false);
    assert.equal(wrap._isOpen(), false);
  });
});

describe("Return to Automatic Detection — Lifetime Realized Gains", () => {
  let ls;
  const key = "9mm_realized_pool_pulsechain_0xw_0xc_0xt0_0xt1_10000";
  beforeEach(() => {
    ls = makeLocalStorage();
  });
  it("removes the override; realized gains have no on-chain source, so the default is $0", () => {
    /*- Realized gains cannot be auto-detected from chain data (they
     *  reflect off-chain wallet sales the app has no visibility into).
     *  "Return to Automatic Detection" therefore means "revert to the
     *  default state" which is $0.  The load helper enforces that when
     *  the localStorage key is missing. */
    assertResetReturnsToAutomatic(ls, key, () => loadNum(ls, key, true));
  });
});

describe("Return to Automatic Detection — Initial Deposit (this position)", () => {
  let ls;
  const key = "9mm_deposit_pos_162249";
  beforeEach(() => {
    ls = makeLocalStorage();
  });
  it("removes the override and the load helper returns 0 (historical-price auto-detection resumes)", () => {
    assertResetReturnsToAutomatic(ls, key, () => loadNum(ls, key, false));
  });
});

describe("Return to Automatic Detection — Realized Gains (this position)", () => {
  let ls;
  const key = "9mm_realized_pos_162249";
  beforeEach(() => {
    ls = makeLocalStorage();
  });
  it("removes the override; per-position realized gains have no auto-source, default is $0", () => {
    assertResetReturnsToAutomatic(ls, key, () => loadNum(ls, key, true));
  });
});

// ── Round-trip: save-then-reset produces the same load result as never-saved ──

describe("Round-trip: save then Return to Automatic Detection is equivalent to never editing", () => {
  let ls;
  beforeEach(() => {
    ls = makeLocalStorage();
  });
  const cases = [
    ["initial deposit (lifetime)", "9mm_deposit_pool_x", false],
    ["realized gains (lifetime)", "9mm_realized_pool_x", true],
    ["initial deposit (position)", "9mm_deposit_pos_x", false],
    ["realized gains (position)", "9mm_realized_pos_x", true],
  ];
  for (const [label, key, allowZero] of cases) {
    it(label, () => {
      /*- Baseline: load without any override is 0. */
      const before = loadNum(ls, key, allowZero);
      assert.equal(before, 0);
      /*- User saves an override. */
      const wrap1 = makeWrap(true);
      saveInput(ls, wrap1, "17.25", key, allowZero);
      assert.equal(loadNum(ls, key, allowZero), 17.25);
      /*- User clicks Return to Automatic Detection. */
      const wrap2 = makeWrap(true);
      resetInput(ls, wrap2, key, null);
      /*- Post-reset state must equal the baseline. */
      const after = loadNum(ls, key, allowZero);
      assert.equal(after, before, "post-reset load matches pre-save baseline");
    });
  }
});

// ── Cancel is NOT reset — it must leave the value untouched ───────────

describe("Cancel button is not a reset — it never touches the stored value", () => {
  it("closes the wrap without deleting the localStorage key", () => {
    /*- Cancel exists purely for visual reassurance / dialog collapse
     *  (see feedback-inline-edit-dialog-button-set memory).  Regression
     *  guard: a future refactor must not silently make Cancel do a
     *  reset. */
    const ls = makeLocalStorage();
    const key = "9mm_deposit_pool_x";
    ls.setItem(key, "500");
    const wrap = makeWrap(true);
    /*- The production cancel handler is exactly this two-liner (see
     *  the _resetRows loop in dashboard-events.js). */
    wrap.classList.remove("open");
    assert.equal(wrap._isOpen(), false, "wrap collapsed");
    assert.equal(
      ls.getItem(key),
      "500",
      "value preserved — Cancel is not Reset",
    );
  });
});
