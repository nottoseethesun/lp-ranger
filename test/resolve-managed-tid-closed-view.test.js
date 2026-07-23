"use strict";

/**
 * @file test/resolve-managed-tid-closed-view.test.js
 * @description Tests the rebalance-follow decision in
 *   `public/dashboard-data.js`.  The prior file mirrored
 *   `_resolveManagedTid` (which combines the decision with a posStore
 *   side effect) inline; the pure decision was extracted as
 *   `_computeRebalanceFollow(a, mp, states) → {migrateTo}` so tests
 *   drive the real module without needing to mock posStore.
 *
 *   The browser migrates its active tokenId only when a rebalance
 *   event `{ oldTokenId: active, newTokenId: p.tokenId }` is present
 *   for a currently-managed position `p`.  The event is the sole
 *   signal.  No same-pool heuristic, no chain walk — the view
 *   converges 1-hop per poll, and the rule works even when two
 *   managed positions share a pool.
 *
 *   Bug history: a prior same-pool `token0 + fee` heuristic would
 *   flip the view to a live managed NFT whenever the user viewed a
 *   closed NFT in the same pool, corrupting the store entry.  The new
 *   rule makes that impossible — an unrelated closed NFT is not the
 *   `oldTokenId` of any rebalance event, so migration is skipped.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../public/dashboard-data.js");
});

const LIVE = {
  tokenId: "159013",
  key: "pulsechain-0xW-0xC-159013",
  status: "running",
};

describe("_computeRebalanceFollow: rebalance-follow by event", () => {
  it("migrates when a rebalance event links active → managed", () => {
    const states = {
      [LIVE.key]: {
        rebalanceEvents: [{ oldTokenId: "158981", newTokenId: "159013" }],
      },
    };
    const active = { tokenId: "158981", liquidity: "12345" };
    const r = mod._computeRebalanceFollow(active, [LIVE], states);
    assert.strictEqual(r.migrateTo, "159013");
  });

  it("migrates when the source NFT is closed (rebalance-from-drained-managed)", () => {
    const states = {
      [LIVE.key]: {
        rebalanceEvents: [{ oldTokenId: "50", newTokenId: "159013" }],
      },
    };
    const active = { tokenId: "50", liquidity: "0" };
    const r = mod._computeRebalanceFollow(active, [LIVE], states);
    assert.strictEqual(r.migrateTo, "159013");
  });

  it(
    "does NOT migrate when viewing an unrelated closed NFT in the same pool " +
      "(the bug: no rebalance event links #158981 → #159013)",
    () => {
      const states = {
        [LIVE.key]: {
          rebalanceEvents: [],
        },
      };
      const active = { tokenId: "158981", liquidity: "0" };
      const r = mod._computeRebalanceFollow(active, [LIVE], states);
      assert.strictEqual(r.migrateTo, null);
    },
  );

  it("picks the correct target when two managed positions share a pool", () => {
    const A = { tokenId: "202", key: "pulsechain-0xW-0xC-202" };
    const B = { tokenId: "500", key: "pulsechain-0xW-0xC-500" };
    const states = {
      [A.key]: {
        rebalanceEvents: [{ oldTokenId: "201", newTokenId: "202" }],
      },
      [B.key]: {
        rebalanceEvents: [{ oldTokenId: "50", newTokenId: "500" }],
      },
    };
    const active = { tokenId: "201", liquidity: "12345" };
    const r = mod._computeRebalanceFollow(active, [B, A], states);
    assert.strictEqual(r.migrateTo, "202");
  });

  it("returns migrateTo=null when the active's tokenId is already in the managed list", () => {
    const states = {
      [LIVE.key]: {
        rebalanceEvents: [{ oldTokenId: "50", newTokenId: "159013" }],
      },
    };
    const active = { tokenId: "159013", liquidity: "0" };
    const r = mod._computeRebalanceFollow(active, [LIVE], states);
    assert.strictEqual(r.migrateTo, null);
  });

  it("returns migrateTo=null when no managed position has a matching event", () => {
    const states = {
      [LIVE.key]: {
        rebalanceEvents: [{ oldTokenId: "99", newTokenId: "100" }],
      },
    };
    const active = { tokenId: "158981", liquidity: "12345" };
    const r = mod._computeRebalanceFollow(active, [LIVE], states);
    assert.strictEqual(r.migrateTo, null);
  });

  it("empty managed-positions array → migrateTo=null", () => {
    const active = { tokenId: "158981" };
    const r = mod._computeRebalanceFollow(active, [], {});
    assert.strictEqual(r.migrateTo, null);
  });

  it("missing states entry for a managed position → no crash, no migration", () => {
    const active = { tokenId: "158981" };
    const r = mod._computeRebalanceFollow(active, [LIVE], {});
    assert.strictEqual(r.migrateTo, null);
  });
});
