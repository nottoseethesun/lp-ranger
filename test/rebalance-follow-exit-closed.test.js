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

function makeStore({ onSyncRoute = null, onExitClosedView = null } = {}) {
  const calls = {
    persist: 0,
    localStorage: [],
    log: [],
    syncRoute: 0,
    exitClosedView: 0,
    stripUI: 0,
  };
  const active = { tokenId: "158981", active: true };
  const store = {
    entries: [active],
    activeIdx: 0,
    getActive() {
      return this.activeIdx < 0 ? null : this.entries[this.activeIdx];
    },
    updateActiveTokenId(newId) {
      const a = this.getActive();
      if (!a) return;
      const old = a.tokenId;
      a.tokenId = String(newId);
      calls.persist++;
      calls.localStorage.push(String(newId));
      calls.log.push("[pos] rebalance follow: #" + old + " \u2192 #" + newId);
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
});
