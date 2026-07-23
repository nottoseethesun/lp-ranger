"use strict";

/**
 * @file test/rebalance-follow-exit-closed.test.js
 * @description Tests the rebalance-follow side-effect in
 *   `posStore.updateActiveTokenId()` from
 *   `public/dashboard-positions-store.js`.  Uses jsdom + real
 *   posStore + registered spy callbacks via the module's public
 *   `setSyncRouteToState` and `setExitClosedPosView` seams.  No
 *   mirror.
 *
 *   The fix under test: after a successful rebalance on a position
 *   the user was viewing as closed (e.g. a drained NFT they
 *   Manage + Rebalance to re-enter the pool), the client migrates
 *   the active tokenId via posStore.updateActiveTokenId(newId).
 *   Before the fix this updated the tokenId + URL but left
 *   `_viewingClosed=true` sticky — so every poll hit
 *   `if (isViewingClosedPos()) return;` in updateDashboardFromStatus
 *   and the freshly-minted live position showed "CLOSED" + dashes.
 *
 *   The fix fires a registered `exitClosedPosView` callback inside
 *   updateActiveTokenId, so the rebalance-follow path unpins the
 *   stale closed-view flag whenever a new NFT is promoted.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../public/dashboard-positions-store.js");
});

let _syncRouteCalls;
let _exitClosedCalls;

beforeEach(() => {
  _syncRouteCalls = [];
  _exitClosedCalls = 0;
  mod.setSyncRouteToState((a) => _syncRouteCalls.push(a));
  mod.setExitClosedPosView(() => _exitClosedCalls++);
  // Reset the store to a known baseline.
  mod.posStore.entries.length = 0;
  mod.posStore.activeIdx = -1;
  localStorage.clear();
});

function _seed(entries, activeIdx = 0) {
  mod.posStore.entries.push(...entries);
  mod.posStore.activeIdx = activeIdx;
}

describe("posStore.updateActiveTokenId — rebalance-follow", () => {
  it("migrates tokenId and persists to localStorage", () => {
    _seed([{ tokenId: "158981", walletAddress: "0xWALLET", active: true }]);
    mod.posStore.updateActiveTokenId("159013");
    assert.strictEqual(mod.posStore.getActive().tokenId, "159013");
    assert.strictEqual(localStorage.getItem("9mm_last_position"), "159013");
  });

  it("fires exitClosedPosView callback (FIX: unpins stale closed-view flag)", () => {
    _seed([{ tokenId: "158981", walletAddress: "0xWALLET", active: true }]);
    mod.posStore.updateActiveTokenId("159013");
    assert.strictEqual(_exitClosedCalls, 1);
  });

  it("fires syncRouteToState callback with the active entry", () => {
    _seed([{ tokenId: "158981", walletAddress: "0xWALLET", active: true }]);
    mod.posStore.updateActiveTokenId("159013");
    assert.strictEqual(_syncRouteCalls.length, 1);
    assert.strictEqual(_syncRouteCalls[0].tokenId, "159013");
  });

  it("fires both callbacks in expected order: exit-closed before sync-route", () => {
    const order = [];
    mod.setSyncRouteToState(() => order.push("sync"));
    mod.setExitClosedPosView(() => order.push("exit"));
    _seed([{ tokenId: "158981", walletAddress: "0xWALLET", active: true }]);
    mod.posStore.updateActiveTokenId("159013");
    assert.deepStrictEqual(order, ["exit", "sync"]);
  });

  it("no-ops cleanly when no active position", () => {
    _seed(
      [{ tokenId: "158981", walletAddress: "0xWALLET" }],
      /*activeIdx=*/ -1,
    );
    mod.posStore.updateActiveTokenId("159013");
    assert.strictEqual(_exitClosedCalls, 0);
    assert.strictEqual(_syncRouteCalls.length, 0);
    assert.strictEqual(localStorage.getItem("9mm_last_position"), null);
  });

  it("is safe when no callbacks registered (defensive)", () => {
    mod.setSyncRouteToState(null);
    mod.setExitClosedPosView(null);
    _seed([{ tokenId: "158981", walletAddress: "0xWALLET", active: true }]);
    assert.doesNotThrow(() => mod.posStore.updateActiveTokenId("159013"));
    assert.strictEqual(mod.posStore.getActive().tokenId, "159013");
  });

  it("no-ops when the newId matches the current tokenId", () => {
    _seed([{ tokenId: "158981", walletAddress: "0xWALLET", active: true }]);
    mod.posStore.updateActiveTokenId("158981");
    assert.strictEqual(_exitClosedCalls, 0);
    assert.strictEqual(_syncRouteCalls.length, 0);
    assert.strictEqual(localStorage.getItem("9mm_last_position"), null);
  });

  it(
    "refuses migration when another entry already has the target tokenId " +
      "for the same wallet (would corrupt Position Browser rows)",
    () => {
      /*- Reproduces the corruption bug: user is viewing a closed NFT
       *  (#158981) in the same pool as a managed live NFT (#159013).
       *  A misfire would try to rewrite the closed entry's tokenId to
       *  159013 — two rows with the same tokenId.  The guard refuses. */
      _seed(
        [
          { tokenId: "159013", walletAddress: "0xWALLET" },
          { tokenId: "158981", walletAddress: "0xWALLET", active: true },
        ],
        /*activeIdx=*/ 1,
      );
      mod.posStore.updateActiveTokenId("159013");
      // Both entries untouched.
      assert.strictEqual(mod.posStore.entries[0].tokenId, "159013");
      assert.strictEqual(mod.posStore.entries[1].tokenId, "158981");
      // No side effects fired.
      assert.strictEqual(_exitClosedCalls, 0);
      assert.strictEqual(_syncRouteCalls.length, 0);
    },
  );

  it("allows migration when duplicate is in a different wallet", () => {
    _seed(
      [
        { tokenId: "159013", walletAddress: "0xOTHERWALLET" },
        { tokenId: "158981", walletAddress: "0xWALLET", active: true },
      ],
      /*activeIdx=*/ 1,
    );
    mod.posStore.updateActiveTokenId("159013");
    assert.strictEqual(mod.posStore.entries[1].tokenId, "159013");
    assert.strictEqual(_exitClosedCalls, 1);
  });
});
