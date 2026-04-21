"use strict";

/**
 * @file test/rebalance-follow-exit-closed.test.js
 * @description Tests the rebalance-follow side-effect in
 * public/dashboard-positions-store.js :: posStore.updateActiveTokenId().
 *
 * Mirrors the logic under test because the real module pulls DOM +
 * localStorage + ES-module deps that node:test can't load.
 *
 * The fix under test: after a successful rebalance on a position the
 * user was viewing as closed (e.g. a drained NFT they Manage + Rebalance
 * to re-enter the pool), the client migrates the active tokenId via
 * posStore.updateActiveTokenId(newId). Before the fix this updated the
 * tokenId + URL but left `_viewingClosed=true` sticky — so every poll
 * hit `if (isViewingClosedPos()) return;` in updateDashboardFromStatus
 * and the freshly-minted live position showed "CLOSED" + dashes despite
 * data flowing from the server.
 *
 * The fix fires a registered `exitClosedPosView` callback inside
 * updateActiveTokenId, so the rebalance-follow path unpins the stale
 * closed-view flag whenever a new NFT is promoted.
 */

const { describe, it } = require("node:test");
const assert = require("assert");

// ── Mirror of updateActiveTokenId from dashboard-positions-store.js ─────

function makeStore({
  onSyncRoute = null,
  onExitClosedView = null,
  entries = null,
  activeIdx = 0,
} = {}) {
  const calls = {
    persist: 0,
    localStorage: [],
    log: [],
    warn: [],
    syncRoute: 0,
    exitClosedView: 0,
    stripUI: 0,
  };
  const defaultEntries = [
    { tokenId: "158981", walletAddress: "0xWALLET", active: true },
  ];
  const store = {
    entries: entries || defaultEntries,
    activeIdx,
    getActive() {
      if (this.activeIdx < 0 || this.activeIdx >= this.entries.length)
        return null;
      return this.entries[this.activeIdx];
    },
    updateActiveTokenId(newId) {
      const a = this.getActive();
      if (!a) return;
      const old = a.tokenId;
      const nid = String(newId);
      if (old === nid) return;
      const w = (a.walletAddress || "").toLowerCase();
      const dup = this.entries.some(
        (e, i) =>
          i !== this.activeIdx &&
          (e.walletAddress || "").toLowerCase() === w &&
          String(e.tokenId) === nid,
      );
      if (dup) {
        calls.warn.push(
          "[pos] rebalance follow REFUSED: #" +
            old +
            " \u2192 #" +
            nid +
            " (duplicate tokenId in store)",
        );
        return;
      }
      a.tokenId = nid;
      calls.persist++;
      calls.localStorage.push(nid);
      calls.log.push("[pos] rebalance follow: #" + old + " \u2192 #" + nid);
      if (onExitClosedView) {
        onExitClosedView();
        calls.exitClosedView++;
      }
      if (onSyncRoute) {
        onSyncRoute(a);
        calls.syncRoute++;
      }
      calls.stripUI++;
    },
  };
  return { store, calls };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("posStore.updateActiveTokenId: rebalance-follow", () => {
  it("migrates tokenId and persists/logs", () => {
    const { store, calls } = makeStore();
    store.updateActiveTokenId("159013");
    assert.strictEqual(store.getActive().tokenId, "159013");
    assert.strictEqual(calls.persist, 1);
    assert.deepStrictEqual(calls.localStorage, ["159013"]);
    assert.strictEqual(
      calls.log[0],
      "[pos] rebalance follow: #158981 \u2192 #159013",
    );
    assert.strictEqual(calls.stripUI, 1);
  });

  it("fires exitClosedPosView callback (FIX: unpins stale closed-view flag)", () => {
    let exitFired = 0;
    const { store, calls } = makeStore({
      onExitClosedView: () => exitFired++,
    });
    store.updateActiveTokenId("159013");
    assert.strictEqual(exitFired, 1);
    assert.strictEqual(calls.exitClosedView, 1);
  });

  it("fires syncRouteToState callback with the active entry", () => {
    let routeArg = null;
    const { store } = makeStore({ onSyncRoute: (a) => (routeArg = a) });
    store.updateActiveTokenId("159013");
    assert.ok(routeArg, "expected active entry to be passed to sync route");
    assert.strictEqual(routeArg.tokenId, "159013");
  });

  it("fires both callbacks in expected order: exit-closed before sync-route", () => {
    const order = [];
    const { store } = makeStore({
      onExitClosedView: () => order.push("exit"),
      onSyncRoute: () => order.push("sync"),
    });
    store.updateActiveTokenId("159013");
    assert.deepStrictEqual(order, ["exit", "sync"]);
  });

  it("no-ops cleanly when no active position", () => {
    const { store, calls } = makeStore({
      onExitClosedView: () => {},
      onSyncRoute: () => {},
    });
    store.activeIdx = -1;
    store.updateActiveTokenId("159013");
    assert.strictEqual(calls.persist, 0);
    assert.strictEqual(calls.exitClosedView, 0);
    assert.strictEqual(calls.syncRoute, 0);
    assert.strictEqual(calls.stripUI, 0);
  });

  it("is safe when no exitClosedPosView callback registered (defensive)", () => {
    const { store } = makeStore();
    assert.doesNotThrow(() => store.updateActiveTokenId("159013"));
    assert.strictEqual(store.getActive().tokenId, "159013");
  });

  it("no-ops when the newId matches the current tokenId", () => {
    const { store, calls } = makeStore({
      onExitClosedView: () => {},
      onSyncRoute: () => {},
    });
    store.updateActiveTokenId("158981");
    assert.strictEqual(calls.persist, 0);
    assert.strictEqual(calls.exitClosedView, 0);
    assert.strictEqual(calls.syncRoute, 0);
  });

  it("refuses migration when another entry already has the target tokenId (same wallet)", () => {
    /*-
     * Reproduces the corruption bug: user is viewing a closed NFT
     * (#158981) in the same pool as a managed live NFT (#159013).
     * A misfire of the rebalance-follow heuristic would try to rewrite
     * the closed entry's tokenId to 159013 — creating two rows with
     * the same tokenId. The guard refuses that mutation.
     */
    const entries = [
      { tokenId: "159013", walletAddress: "0xWALLET" }, // live managed (idx 0)
      { tokenId: "158981", walletAddress: "0xWALLET", active: true }, // closed viewed (idx 1)
    ];
    const { store, calls } = makeStore({
      entries,
      activeIdx: 1,
      onExitClosedView: () => {},
      onSyncRoute: () => {},
    });
    store.updateActiveTokenId("159013");
    // Active entry is untouched.
    assert.strictEqual(store.entries[1].tokenId, "158981");
    // Other entry is untouched.
    assert.strictEqual(store.entries[0].tokenId, "159013");
    // No side effects fired.
    assert.strictEqual(calls.persist, 0);
    assert.strictEqual(calls.exitClosedView, 0);
    assert.strictEqual(calls.syncRoute, 0);
    // Warning logged.
    assert.match(calls.warn[0], /rebalance follow REFUSED/);
  });

  it("allows migration when duplicate is in a different wallet", () => {
    const entries = [
      { tokenId: "159013", walletAddress: "0xOTHERWALLET" },
      { tokenId: "158981", walletAddress: "0xWALLET", active: true },
    ];
    const { store, calls } = makeStore({
      entries,
      activeIdx: 1,
      onExitClosedView: () => {},
      onSyncRoute: () => {},
    });
    store.updateActiveTokenId("159013");
    assert.strictEqual(store.entries[1].tokenId, "159013");
    assert.strictEqual(calls.persist, 1);
  });
});
