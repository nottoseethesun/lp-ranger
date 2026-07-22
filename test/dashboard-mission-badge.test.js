"use strict";

/**
 * @file test/dashboard-mission-badge.test.js
 * @description Tests for `findActiveActions` and `findActiveAction` in
 *   `public/dashboard-mission-badge.js`.  Mirrored in CJS because the
 *   module imports `dashboard-positions.js` which transitively pulls
 *   in wallet, data, kpi, and manage-ui — a heavy graph to import
 *   under Node just to test two pure-ish dispatch helpers.
 *
 *   Scope: state-map scan + kind derivation + symbol lookup via
 *   posStore.  Optimistic-latch, DOM-paint, and clear-latch paths are
 *   out of scope for this suite (they touch DOM + timers).
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// ── In-test replica ────────────────────────────────────────────────────────

let _posStoreEntries;

const posStore = {
  get entries() {
    return _posStoreEntries;
  },
};

function findActiveActions(allStates) {
  if (!allStates) return [];
  const out = [];
  for (const [key, s] of Object.entries(allStates)) {
    const kind = s.rebalanceInProgress
      ? "rebalance"
      : s.compoundInProgress
        ? "compound"
        : null;
    if (!kind) continue;
    const tokenId = key.split("-").pop();
    const ap = s.activePosition || {};
    const entry = posStore.entries.find((e) => e.tokenId === tokenId);
    out.push({
      kind,
      tokenId,
      fee: ap.fee ?? entry?.fee,
      token0Symbol: entry?.token0Symbol,
      token1Symbol: entry?.token1Symbol,
    });
  }
  return out;
}

function findActiveAction(allStates) {
  const all = findActiveActions(allStates);
  return all[0] || null;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

beforeEach(() => {
  _posStoreEntries = [
    { tokenId: "157149", fee: 500, token0Symbol: "PLS", token1Symbol: "wETH" },
    { tokenId: "160123", fee: 3000, token0Symbol: "HEX", token1Symbol: "USDC" },
  ];
});

function _stateFor(tokenId, patch) {
  return {
    [`pulsechain-0xWALLET-0xCONTRACT-${tokenId}`]: {
      status: "running",
      rebalanceInProgress: false,
      compoundInProgress: false,
      activePosition: {},
      ...(patch || {}),
    },
  };
}

// ── findActiveActions ──────────────────────────────────────────────────────

describe("findActiveActions()", () => {
  it("returns [] for null / undefined / empty state maps", () => {
    assert.deepStrictEqual(findActiveActions(null), []);
    assert.deepStrictEqual(findActiveActions(undefined), []);
    assert.deepStrictEqual(findActiveActions({}), []);
  });

  it("skips positions with no action in progress", () => {
    const states = _stateFor("157149", { status: "running" });
    assert.deepStrictEqual(findActiveActions(states), []);
  });

  it("returns a 'rebalance' entry when rebalanceInProgress is true", () => {
    const states = _stateFor("157149", { rebalanceInProgress: true });
    const out = findActiveActions(states);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0], {
      kind: "rebalance",
      tokenId: "157149",
      fee: 500,
      token0Symbol: "PLS",
      token1Symbol: "wETH",
    });
  });

  it("returns a 'compound' entry when compoundInProgress is true", () => {
    const states = _stateFor("160123", { compoundInProgress: true });
    const out = findActiveActions(states);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0], {
      kind: "compound",
      tokenId: "160123",
      fee: 3000,
      token0Symbol: "HEX",
      token1Symbol: "USDC",
    });
  });

  it(
    "prefers 'rebalance' over 'compound' when BOTH flags are true — " +
      "rebalance is the heavier operation, so it wins the primary label",
    () => {
      const states = _stateFor("157149", {
        rebalanceInProgress: true,
        compoundInProgress: true,
      });
      const out = findActiveActions(states);
      assert.strictEqual(out[0].kind, "rebalance");
    },
  );

  it("prefers activePosition.fee over posStore entry.fee when both are present", () => {
    const states = _stateFor("157149", {
      rebalanceInProgress: true,
      activePosition: { fee: 10000 },
    });
    const out = findActiveActions(states);
    assert.strictEqual(out[0].fee, 10000);
  });

  it("stacks multiple concurrent actions (rare but real when queued behind the rebalance lock)", () => {
    const states = {
      ..._stateFor("157149", { rebalanceInProgress: true }),
      ..._stateFor("160123", { compoundInProgress: true }),
    };
    const out = findActiveActions(states);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].kind, "rebalance");
    assert.strictEqual(out[1].kind, "compound");
  });

  it("still returns an entry when posStore has no matching tokenId (undefined symbols)", () => {
    _posStoreEntries = [];
    const states = _stateFor("999999", { rebalanceInProgress: true });
    const out = findActiveActions(states);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].token0Symbol, undefined);
    assert.strictEqual(out[0].token1Symbol, undefined);
  });
});

// ── findActiveAction (legacy single-action wrapper) ────────────────────────

describe("findActiveAction()", () => {
  it("returns null when no positions have actions", () => {
    assert.strictEqual(findActiveAction({}), null);
  });

  it("returns the first entry when at least one action is active", () => {
    const states = _stateFor("157149", { rebalanceInProgress: true });
    const out = findActiveAction(states);
    assert.strictEqual(out?.tokenId, "157149");
    assert.strictEqual(out?.kind, "rebalance");
  });
});
