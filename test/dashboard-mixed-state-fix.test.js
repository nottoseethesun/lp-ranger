"use strict";

/**
 * @file test/dashboard-mixed-state-fix.test.js
 * @description Tests for the "tokenId correct, pool name stale" mixed-
 * state render bug.  Bug repro: open dashboard at a deep-link URL for a
 * position whose posStore entry has stale token0Symbol / token1Symbol /
 * fee from a previously-viewed position.  The URL/tokenId shows correctly
 * but the pool name and fee tier carry over from the prior position.
 *
 * Two production fixes are covered here, mirrored because the real
 * modules pull DOM + localStorage + ES-module deps that node:test can't
 * load:
 *
 * 1. `posStore.add()` dedup branch in
 *    `public/dashboard-positions-store.js` now refreshes pool-identity
 *    fields (token0, token1, fee, tickLower, tickUpper) on top of the
 *    symbol/liquidity refresh that was already there — so re-scans
 *    self-heal stale entries.
 *
 * 2. `_syncActivePosition` in `public/dashboard-data.js` now also
 *    propagates token0Symbol / token1Symbol from `data.activePosition`
 *    to the posStore active entry, and triggers `updatePosStripUI()`
 *    when any pool-identity field actually changed — so the strip
 *    re-renders with the corrected pool name and fee tier.
 *
 * 3. `dashboard-unmanaged.js` now drops stale pending fetches
 *    (`flushPendingUnmanagedFetch`) and stale in-flight phase1 results
 *    when posStore's active tokenId no longer matches the queued/inflight
 *    tokenId.  Without these guards a fetch queued during wallet-lock
 *    can fire after the user has navigated to a different NFT, painting
 *    the old position's $$ over the new position's labels.
 *
 * The matching server-side change (`_activePosSummary` now includes
 * symbols) is covered by an extra test in test/bot-recorder.test.js.
 */

const { describe, it } = require("node:test");
const assert = require("assert");
const { _activePosSummary } = require("../src/bot-recorder");

// ── Server-side: _activePosSummary now ships symbols to the client ─────

describe("_activePosSummary includes symbols", () => {
  it("propagates token0Symbol and token1Symbol so the dashboard can self-heal stale pool labels", () => {
    /*- The dashboard's posStore active entry mirrors this payload on
     *  every poll.  When a rebalance-follow migrates the active
     *  tokenId, the new pool's symbols must propagate too — otherwise
     *  the previously-viewed position's symbols persist and produce a
     *  mixed-state UI render. */
    const s = _activePosSummary({
      tokenId: 1n,
      token0: "0xA",
      token1: "0xB",
      fee: 10000,
      token0Symbol: "HEX",
      token1Symbol: "eHEX",
    });
    assert.strictEqual(s.token0Symbol, "HEX");
    assert.strictEqual(s.token1Symbol, "eHEX");
  });
});

// ── Mirror of posStore.add dedup branch ─────────────────────────────────

/**
 * Mirror of the dedup-refresh branch from public/dashboard-positions-store.js
 * `posStore.add()` — same field-update semantics, no DOM/localStorage.
 */
function dedupRefresh(existing, entry) {
  if (entry.token0Symbol) existing.token0Symbol = entry.token0Symbol;
  if (entry.token1Symbol) existing.token1Symbol = entry.token1Symbol;
  if (entry.liquidity !== undefined) existing.liquidity = entry.liquidity;
  if (entry.contractAddress) existing.contractAddress = entry.contractAddress;
  if (entry.poolTick !== undefined && entry.poolTick !== null)
    existing.poolTick = entry.poolTick;
  if (entry.scanInRange !== undefined && entry.scanInRange !== null)
    existing.scanInRange = entry.scanInRange;
  if (entry.token0) existing.token0 = entry.token0;
  if (entry.token1) existing.token1 = entry.token1;
  if (entry.fee !== undefined && entry.fee !== null) existing.fee = entry.fee;
  if (entry.tickLower !== undefined && entry.tickLower !== null)
    existing.tickLower = entry.tickLower;
  if (entry.tickUpper !== undefined && entry.tickUpper !== null)
    existing.tickUpper = entry.tickUpper;
  return existing;
}

describe("posStore.add dedup branch refreshes pool-identity fields", () => {
  it("rewrites token0/token1/fee/ticks when scan returns fresh values", () => {
    /*- Simulates the bug: the stored entry has Maximus-era pool info,
     *  the rescan returns the actual HEX/eHEX pool info that owns this
     *  tokenId today.  Without the fix, only symbols/liquidity were
     *  refreshed and the stale pool fields persisted forever. */
    const existing = {
      tokenId: "159250",
      walletAddress: "0xWALLET",
      positionType: "nft",
      token0: "0xMAXIMUS_OLD",
      token1: "0xMAXIMUS_E_OLD",
      fee: 10000,
      tickLower: -100,
      tickUpper: 100,
      token0Symbol: "Maximus",
      token1Symbol: "Maximus from Ethereum",
    };
    const fresh = {
      tokenId: "159250",
      walletAddress: "0xWALLET",
      positionType: "nft",
      token0: "0xHEX",
      token1: "0xeHEX",
      fee: 10000,
      tickLower: -200,
      tickUpper: 200,
      token0Symbol: "HEX",
      token1Symbol: "eHEX",
    };
    dedupRefresh(existing, fresh);
    assert.strictEqual(existing.token0, "0xHEX");
    assert.strictEqual(existing.token1, "0xeHEX");
    assert.strictEqual(existing.tickLower, -200);
    assert.strictEqual(existing.tickUpper, 200);
    assert.strictEqual(existing.token0Symbol, "HEX");
    assert.strictEqual(existing.token1Symbol, "eHEX");
  });

  it("leaves existing fields alone when fresh entry omits them", () => {
    const existing = {
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
      tickLower: -10,
      tickUpper: 10,
      token0Symbol: "A",
      token1Symbol: "B",
    };
    dedupRefresh(existing, { liquidity: "999" });
    assert.strictEqual(existing.token0, "0xA");
    assert.strictEqual(existing.token1, "0xB");
    assert.strictEqual(existing.fee, 3000);
    assert.strictEqual(existing.tickLower, -10);
    assert.strictEqual(existing.tickUpper, 10);
    assert.strictEqual(existing.token0Symbol, "A");
    assert.strictEqual(existing.token1Symbol, "B");
    assert.strictEqual(existing.liquidity, "999");
  });

  it("treats fee=0 and tick=0 as legitimate values (no falsy skips)", () => {
    /*- Defensive: ticks frequently land on 0; fee never does in
     *  practice but the != null / != undefined guards must not gate on
     *  truthiness. */
    const existing = { fee: 10000, tickLower: 100, tickUpper: 200 };
    dedupRefresh(existing, { fee: 500, tickLower: 0, tickUpper: 0 });
    assert.strictEqual(existing.fee, 500);
    assert.strictEqual(existing.tickLower, 0);
    assert.strictEqual(existing.tickUpper, 0);
  });
});

// ── Mirror of _syncActivePosition from dashboard-data.js ───────────────

/**
 * Mirror of `_syncActivePosition` after the fix.  Returns
 * { stripRendered: boolean } so tests can assert on the re-render
 * trigger.  In production `updatePosStripUI()` is called instead.
 */
function syncActivePosition(active, ap) {
  let stripRendered = false;
  const fakeRender = () => {
    stripRendered = true;
  };
  if (!ap) return { stripRendered };
  if (!active || active.positionType !== "nft") return { stripRendered };
  if (ap.liquidity !== undefined) active.liquidity = String(ap.liquidity);
  if (ap.tickLower !== undefined) {
    active.tickLower = ap.tickLower;
    active.tickUpper = ap.tickUpper;
  }
  let poolIdentityChanged = false;
  if (ap.token0) {
    if (
      active.token0 !== ap.token0 ||
      active.token1 !== ap.token1 ||
      active.fee !== ap.fee
    ) {
      poolIdentityChanged = true;
    }
    active.token0 = ap.token0;
    active.token1 = ap.token1;
    active.fee = ap.fee;
  }
  if (ap.token0Symbol && active.token0Symbol !== ap.token0Symbol) {
    active.token0Symbol = ap.token0Symbol;
    poolIdentityChanged = true;
  }
  if (ap.token1Symbol && active.token1Symbol !== ap.token1Symbol) {
    active.token1Symbol = ap.token1Symbol;
    poolIdentityChanged = true;
  }
  if (ap.tokenId) active.tokenId = String(ap.tokenId);
  if (poolIdentityChanged) fakeRender();
  return { stripRendered };
}

describe("_syncActivePosition", () => {
  it("propagates token0Symbol/token1Symbol from activePosition", () => {
    const active = {
      positionType: "nft",
      tokenId: "159250",
      token0Symbol: "Maximus",
      token1Symbol: "Maximus from Ethereum",
    };
    syncActivePosition(active, {
      tokenId: "159250",
      token0Symbol: "HEX",
      token1Symbol: "eHEX",
    });
    assert.strictEqual(active.token0Symbol, "HEX");
    assert.strictEqual(active.token1Symbol, "eHEX");
  });

  it("triggers strip re-render when symbols change", () => {
    const active = {
      positionType: "nft",
      tokenId: "159250",
      token0Symbol: "Maximus",
      token1Symbol: "Maximus from Ethereum",
    };
    const r = syncActivePosition(active, {
      tokenId: "159250",
      token0Symbol: "HEX",
      token1Symbol: "eHEX",
    });
    assert.strictEqual(r.stripRendered, true);
  });

  it("triggers strip re-render when token0/token1/fee change", () => {
    const active = {
      positionType: "nft",
      tokenId: "1",
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
    };
    const r = syncActivePosition(active, {
      tokenId: "1",
      token0: "0xC",
      token1: "0xD",
      fee: 10000,
    });
    assert.strictEqual(r.stripRendered, true);
    assert.strictEqual(active.token0, "0xC");
    assert.strictEqual(active.fee, 10000);
  });

  it("does not re-render when no pool-identity field changed", () => {
    const active = {
      positionType: "nft",
      tokenId: "1",
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
      token0Symbol: "A",
      token1Symbol: "B",
      liquidity: "100",
    };
    const r = syncActivePosition(active, {
      tokenId: "1",
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
      token0Symbol: "A",
      token1Symbol: "B",
      liquidity: "200",
      tickLower: -10,
      tickUpper: 10,
    });
    assert.strictEqual(r.stripRendered, false);
    /*- Liquidity and ticks still apply, just no re-render. */
    assert.strictEqual(active.liquidity, "200");
    assert.strictEqual(active.tickLower, -10);
  });

  it("ignores non-nft positions", () => {
    const active = {
      positionType: "erc20",
      token0Symbol: "Maximus",
    };
    const r = syncActivePosition(active, {
      tokenId: "1",
      token0Symbol: "HEX",
    });
    assert.strictEqual(r.stripRendered, false);
    /*- Active entry untouched. */
    assert.strictEqual(active.token0Symbol, "Maximus");
  });

  it("no-ops when no active position", () => {
    const r = syncActivePosition(null, { tokenId: "1", token0Symbol: "X" });
    assert.strictEqual(r.stripRendered, false);
  });

  it("no-ops when no activePosition payload", () => {
    const active = { positionType: "nft", token0Symbol: "X" };
    const r = syncActivePosition(active, null);
    assert.strictEqual(r.stripRendered, false);
    assert.strictEqual(active.token0Symbol, "X");
  });
});

// ── Mirror of dashboard-unmanaged.js stale-target guards ────────────────

/**
 * Mirror of `_activeMatches` plus the flush/phase1 entry-guard logic
 * from public/dashboard-unmanaged.js.  Production routes mutate DOM and
 * issue fetches; this mirror returns a string outcome so tests can
 * assert which branch fired.
 *
 * Outcomes:
 *   "fetch"      — passed all guards, would fetch
 *   "drop"       — active position no longer matches the queued/inflight
 *                  tokenId; result/fetch dropped to avoid the
 *                  "tokenId correct, pool name stale" mixed-state bug
 *   "no-pending" — flush called with nothing queued
 */
function activeMatches(active, tokenId) {
  return !!active && String(active.tokenId) === String(tokenId);
}

function flushPending(active, pendingPos) {
  if (!pendingPos) return "no-pending";
  if (!activeMatches(active, pendingPos.tokenId)) return "drop";
  return "fetch";
}

function phase1ApplyGate(active, fetchedTokenId) {
  return activeMatches(active, fetchedTokenId) ? "apply" : "drop";
}

describe("dashboard-unmanaged stale-target guards", () => {
  it("flushPending drops a pending fetch when the active position changed", () => {
    /*- Repro: bestAutoSelect queued #159322 while wallet was locked.
     *  URL routing then activated #159250 (a closed NFT).  On unlock
     *  the stale #159322 pending must NOT fire — otherwise its data
     *  paints over #159250's already-rendered labels (the
     *  "tokenId correct, pool name stale" mixed-state bug). */
    const active = { tokenId: "159250" };
    const pending = { tokenId: "159322" };
    assert.strictEqual(flushPending(active, pending), "drop");
  });

  it("flushPending fires when active still matches queued tokenId", () => {
    const active = { tokenId: "159322" };
    const pending = { tokenId: "159322" };
    assert.strictEqual(flushPending(active, pending), "fetch");
  });

  it("flushPending no-ops when nothing was queued", () => {
    const active = { tokenId: "159250" };
    assert.strictEqual(flushPending(active, null), "no-pending");
  });

  it("phase1ApplyGate drops a result whose tokenId no longer matches", () => {
    /*- In-flight fetch race: phase1 started for #159322, user
     *  navigated to #159250 mid-flight.  Result must be dropped before
     *  _apply paints stale $$ over the new view. */
    const active = { tokenId: "159250" };
    assert.strictEqual(phase1ApplyGate(active, "159322"), "drop");
  });

  it("phase1ApplyGate applies a result whose tokenId still matches", () => {
    const active = { tokenId: "159322" };
    assert.strictEqual(phase1ApplyGate(active, "159322"), "apply");
  });

  it("activeMatches compares as strings (numeric tokenId mismatch is not type-coerced away)", () => {
    /*- posStore stores tokenId as a string; some payloads arrive
     *  numeric.  String comparison is the contract. */
    assert.strictEqual(activeMatches({ tokenId: "159250" }, 159250), true);
    assert.strictEqual(activeMatches({ tokenId: 159250 }, "159250"), true);
    assert.strictEqual(activeMatches(null, "159250"), false);
    assert.strictEqual(activeMatches({ tokenId: "159250" }, "159322"), false);
  });
});
