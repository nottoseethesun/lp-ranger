"use strict";

/**
 * @file test/resolve-managed-tid-closed-view.test.js
 * @description Tests the rebalance-follow logic in
 * public/dashboard-data.js :: _resolveManagedTid() and
 * public/dashboard-data-cache.js :: flattenV2Status().
 *
 * The browser migrates its active tokenId only when a rebalance event
 * `{ oldTokenId: active, newTokenId: p.tokenId }` is present for a
 * currently-managed position `p`.  The event is the sole signal.  No
 * same-pool heuristic, no chain walk — the view converges 1-hop per
 * poll, and the rule works even when two managed positions share a
 * pool.
 *
 * Bug history: a prior same-pool `token0 + fee` heuristic would flip
 * the view to a live managed NFT whenever the user viewed a closed
 * NFT in the same pool, corrupting the store entry.  The new rule
 * makes that impossible — an unrelated closed NFT is not the
 * `oldTokenId` of any rebalance event, so migration is skipped.
 *
 * Mirrors the real function because the actual modules pull DOM +
 * localStorage + ES-module deps that node:test can't load.
 */

const { describe, it } = require("node:test");
const assert = require("assert");

// ── Mirror of _resolveManagedTid ────────────────────────────────────────

function resolveManagedTid(a, mp, states, onMigrate) {
  const tid = String(a.tokenId);
  if (mp.some((p) => String(p.tokenId) === tid)) return tid;
  for (const p of mp) {
    const events = states[p.key]?.rebalanceEvents || [];
    const hit = events.some(
      (e) =>
        String(e.oldTokenId) === tid &&
        String(e.newTokenId) === String(p.tokenId),
    );
    if (hit) {
      if (onMigrate) onMigrate(p.tokenId);
      return p.tokenId;
    }
  }
  return tid;
}

// ── Fixture: HEX/eHEX pool with live #159013 ────────────────────────────

const POOL_T0 = "0x2b591e99afe9f32eaa6214f7b7629768c40eeb39";
const FEE = 2500;
const LIVE = {
  tokenId: "159013",
  key: "pulsechain-0xW-0xC-159013",
  status: "running",
};

describe("_resolveManagedTid: rebalance-follow by event", () => {
  it("migrates when a rebalance event links active → managed", () => {
    const states = {
      [LIVE.key]: {
        rebalanceEvents: [{ oldTokenId: "158981", newTokenId: "159013" }],
      },
    };
    const active = {
      tokenId: "158981",
      token0: POOL_T0,
      fee: FEE,
      liquidity: "12345",
    };
    let migrated = null;
    const tid = resolveManagedTid(
      active,
      [LIVE],
      states,
      (nid) => (migrated = nid),
    );
    assert.strictEqual(tid, "159013");
    assert.strictEqual(migrated, "159013");
  });

  it("migrates when the source NFT is closed (rebalance-from-drained-managed)", () => {
    /*-
     * User marks an old closed NFT as managed and rebalances.  The bot
     * emits `{ old, new }`; the view follows to the fresh NFT.
     */
    const states = {
      [LIVE.key]: {
        rebalanceEvents: [{ oldTokenId: "50", newTokenId: "159013" }],
      },
    };
    const active = {
      tokenId: "50",
      token0: POOL_T0,
      fee: FEE,
      liquidity: "0",
    };
    let migrated = null;
    const tid = resolveManagedTid(
      active,
      [LIVE],
      states,
      (nid) => (migrated = nid),
    );
    assert.strictEqual(tid, "159013");
    assert.strictEqual(migrated, "159013");
  });

  it("does NOT migrate when viewing an unrelated closed NFT in the same pool (the bug)", () => {
    /*-
     * No rebalance event links #158981 → #159013.  User is just
     * browsing a drained NFT that happens to share `token0 + fee`
     * with a live managed position.  View must not flip.
     */
    const states = {
      [LIVE.key]: {
        rebalanceEvents: [],
      },
    };
    const active = {
      tokenId: "158981",
      token0: POOL_T0,
      fee: FEE,
      liquidity: "0",
    };
    let migrated = null;
    const tid = resolveManagedTid(
      active,
      [LIVE],
      states,
      (nid) => (migrated = nid),
    );
    assert.strictEqual(tid, "158981");
    assert.strictEqual(migrated, null);
  });

  it("picks the correct target when two managed positions share a pool", () => {
    /*-
     * Pool has two managed positions: #202 (derived from #201 by
     * rebalance) and #500 (derived from #50).  Browser active is
     * #201.  The event for #202's bucket links 201→202, so we must
     * migrate to #202, never to #500.
     */
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
    const active = {
      tokenId: "201",
      token0: POOL_T0,
      fee: FEE,
      liquidity: "12345",
    };
    let migrated = null;
    const tid = resolveManagedTid(
      active,
      [B, A],
      states,
      (nid) => (migrated = nid),
    );
    assert.strictEqual(tid, "202");
    assert.strictEqual(migrated, "202");
  });

  it("returns tid as-is when active's tokenId is already in the managed list", () => {
    const states = {
      [LIVE.key]: {
        rebalanceEvents: [{ oldTokenId: "50", newTokenId: "159013" }],
      },
    };
    const active = {
      tokenId: "159013",
      token0: POOL_T0,
      fee: FEE,
      liquidity: "0",
    };
    let migrated = null;
    const tid = resolveManagedTid(
      active,
      [LIVE],
      states,
      (nid) => (migrated = nid),
    );
    assert.strictEqual(tid, "159013");
    assert.strictEqual(migrated, null);
  });

  it("returns tid as-is when no managed position has a matching rebalance event", () => {
    const states = {
      [LIVE.key]: {
        rebalanceEvents: [{ oldTokenId: "99", newTokenId: "100" }],
      },
    };
    const active = { tokenId: "158981", liquidity: "12345" };
    let migrated = null;
    const tid = resolveManagedTid(
      active,
      [LIVE],
      states,
      (nid) => (migrated = nid),
    );
    assert.strictEqual(tid, "158981");
    assert.strictEqual(migrated, null);
  });
});
