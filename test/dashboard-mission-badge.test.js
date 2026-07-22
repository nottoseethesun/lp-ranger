"use strict";

/**
 * @file test/dashboard-mission-badge.test.js
 * @description Tests for `findActiveActions` and `findActiveAction` in
 *   `public/dashboard-mission-badge.js`.  Uses jsdom + direct import of
 *   the real browser module.
 *
 *   `dashboard-mission-badge` imports `posStore` from
 *   `dashboard-positions.js`, which has a heavy transitive graph.  We
 *   test-drive the module's state through the ONLY external surface it
 *   uses in these functions: `posStore.entries`.  Rather than importing
 *   the transitive `dashboard-positions` module directly (which pulls
 *   wallet, data, kpi, manage-ui at load time), we import
 *   `dashboard-positions-store` — the actual owner of `posStore.entries`
 *   — and mutate its live array before each test.
 *
 *   Scope: state-map scan + kind derivation + symbol lookup via
 *   posStore.  Optimistic-latch, DOM-paint, and clear-latch paths are
 *   out of scope for this suite (they touch modal DOM + timers).
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;
let store;

before(async () => {
  // Import the underlying posStore first, then mission-badge so its
  // `posStore` binding resolves via the shared module instance.
  store = await import("../public/dashboard-positions-store.js");
  mod = await import("../public/dashboard-mission-badge.js");
});

beforeEach(() => {
  // Reset posStore.entries to a known baseline.  posStore is a
  // singleton in the module graph — every test starts from a fresh
  // two-position store.
  store.posStore.entries.length = 0;
  store.posStore.entries.push(
    {
      tokenId: "157149",
      fee: 500,
      token0Symbol: "PLS",
      token1Symbol: "wETH",
    },
    {
      tokenId: "160123",
      fee: 3000,
      token0Symbol: "HEX",
      token1Symbol: "USDC",
    },
  );
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
    assert.deepStrictEqual(mod.findActiveActions(null), []);
    assert.deepStrictEqual(mod.findActiveActions(undefined), []);
    assert.deepStrictEqual(mod.findActiveActions({}), []);
  });

  it("skips positions with no action in progress", () => {
    const states = _stateFor("157149", { status: "running" });
    assert.deepStrictEqual(mod.findActiveActions(states), []);
  });

  it("returns a 'rebalance' entry when rebalanceInProgress is true", () => {
    const states = _stateFor("157149", { rebalanceInProgress: true });
    const out = mod.findActiveActions(states);
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
    const out = mod.findActiveActions(states);
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
      const out = mod.findActiveActions(states);
      assert.strictEqual(out[0].kind, "rebalance");
    },
  );

  it("prefers activePosition.fee over posStore entry.fee when both are present", () => {
    const states = _stateFor("157149", {
      rebalanceInProgress: true,
      activePosition: { fee: 10000 },
    });
    const out = mod.findActiveActions(states);
    assert.strictEqual(out[0].fee, 10000);
  });

  it("stacks multiple concurrent actions (rare but real when queued behind the rebalance lock)", () => {
    const states = {
      ..._stateFor("157149", { rebalanceInProgress: true }),
      ..._stateFor("160123", { compoundInProgress: true }),
    };
    const out = mod.findActiveActions(states);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].kind, "rebalance");
    assert.strictEqual(out[1].kind, "compound");
  });

  it("still returns an entry when posStore has no matching tokenId (undefined symbols)", () => {
    store.posStore.entries.length = 0;
    const states = _stateFor("999999", { rebalanceInProgress: true });
    const out = mod.findActiveActions(states);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].token0Symbol, undefined);
    assert.strictEqual(out[0].token1Symbol, undefined);
  });
});

// ── findActiveAction (legacy single-action wrapper) ────────────────────────

describe("findActiveAction()", () => {
  it("returns null when no positions have actions", () => {
    assert.strictEqual(mod.findActiveAction({}), null);
  });

  it("returns the first entry when at least one action is active", () => {
    const states = _stateFor("157149", { rebalanceInProgress: true });
    const out = mod.findActiveAction(states);
    assert.strictEqual(out?.tokenId, "157149");
    assert.strictEqual(out?.kind, "rebalance");
  });
});
