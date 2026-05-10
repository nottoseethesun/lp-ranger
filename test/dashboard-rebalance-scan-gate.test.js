"use strict";

/**
 * @file test/dashboard-rebalance-scan-gate.test.js
 * @description Tests for the rebalance-trigger gate in
 *   `public/dashboard-data-events.js` `_handleRebalance`.  The dashboard
 *   module is an ES module bundled by esbuild for the browser; we
 *   replicate the gate in CommonJS for direct test access — same pattern
 *   as `test/dashboard-csrf-fetch.test.js` and `test/dashboard-idle.test.js`.
 *
 *   Bug under test: during burn-in a managed-but-unfocused position
 *   that rebalanced while the user was away/idle showed up in the LP
 *   Browser as "old NFT closed, new NFT missing" until a manual scan.
 *   Root cause: the silent scan triggered on `lastRebalanceAt` change
 *   was fire-and-forget AND `_lastRebAt` was advanced before the scan
 *   ran, so a transient failure (CSRF Unknown, RPC blip, etc.) left
 *   the tracker masking the rebalance forever — no retry on the next
 *   poll.
 *
 *   Fix: trigger the scan first, and only advance `_lastRebAt` (which
 *   ALSO gates the Activity Log entry) inside the `.then()` after
 *   `r.ok`.  Concurrent in-flight scans dedupe via a second check on
 *   the same tracker (`_lastRebAt[key] === at` → already handled).
 *   Failed scans leave the tracker unset and naturally retry on the
 *   next 3 s `/api/status` poll.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/* ── In-test replica of the gate ─────────────────────────────────────── */

let _lastRebAt;
let _scanCalls;
let _scanImpl;
let _logCalls;

function _act(...args) {
  _logCalls.push(args);
}

async function _scanPositions(opts) {
  _scanCalls.push(opts);
  return _scanImpl(_scanCalls.length);
}

function _handleRebalance(key, st) {
  if (!st.lastRebalanceAt || st.lastRebalanceAt === _lastRebAt.get(key)) return;
  const at = st.lastRebalanceAt;
  const evts = st.rebalanceEvents || [];
  const ev = evts.length ? evts[evts.length - 1] : null;
  return _scanPositions({ silent: true }).then((r) => {
    if (!r?.ok) return;
    if (_lastRebAt.get(key) === at) return;
    _lastRebAt.set(key, at);
    if (!ev) return;
    _act("Rebalance", ev.oldTokenId, ev.newTokenId);
  });
}

beforeEach(() => {
  _lastRebAt = new Map();
  _scanCalls = [];
  _scanImpl = null;
  _logCalls = [];
});

const _key = "pulsechain-0xabc-0xdef-100";
const _ev1 = { oldTokenId: "100", newTokenId: "200", txHash: "0xaaa" };
const _ev2 = { oldTokenId: "200", newTokenId: "300", txHash: "0xbbb" };

/* ── Tests ───────────────────────────────────────────────────────────── */

describe("_handleRebalance gate", () => {
  it("does nothing when lastRebalanceAt is missing", async () => {
    _scanImpl = async () => {
      throw new Error("scan should not be called");
    };
    await _handleRebalance(_key, { lastRebalanceAt: null });
    assert.strictEqual(_scanCalls.length, 0);
    assert.strictEqual(_logCalls.length, 0);
  });

  it("does nothing when lastRebalanceAt matches the tracker", async () => {
    _lastRebAt.set(_key, "2026-05-10T00:00:00.000Z");
    _scanImpl = async () => {
      throw new Error("scan should not be called");
    };
    await _handleRebalance(_key, {
      lastRebalanceAt: "2026-05-10T00:00:00.000Z",
      rebalanceEvents: [_ev1],
    });
    assert.strictEqual(_scanCalls.length, 0);
    assert.strictEqual(_logCalls.length, 0);
  });

  it("on successful scan: advances tracker and logs once", async () => {
    _scanImpl = async () => ({ ok: true, added: 1, nftCount: 2 });
    await _handleRebalance(_key, {
      lastRebalanceAt: "2026-05-10T01:00:00.000Z",
      rebalanceEvents: [_ev1],
    });
    assert.strictEqual(_scanCalls.length, 1);
    assert.strictEqual(_logCalls.length, 1);
    assert.strictEqual(_lastRebAt.get(_key), "2026-05-10T01:00:00.000Z");
  });

  it("on failed scan: tracker stays unset and no log", async () => {
    _scanImpl = async () => ({ ok: false, error: "CSRF Unknown" });
    await _handleRebalance(_key, {
      lastRebalanceAt: "2026-05-10T01:00:00.000Z",
      rebalanceEvents: [_ev1],
    });
    assert.strictEqual(_scanCalls.length, 1);
    assert.strictEqual(_logCalls.length, 0);
    assert.strictEqual(_lastRebAt.has(_key), false);
  });

  it("retry after failure: next poll re-fires and succeeds, logs once", async () => {
    /*- The exact sequence the bug used to produce: idle-time scan
     *  failed silently and the rebalance was masked forever.  With the
     *  fix, the next poll's call to _handleRebalance sees the tracker
     *  still unset and retries the scan.  When the second attempt
     *  returns ok, the tracker advances and the Activity Log entry
     *  fires (only once across the whole sequence). */
    let attempt = 0;
    _scanImpl = async () => {
      attempt += 1;
      return attempt === 1 ? { ok: false } : { ok: true, added: 1 };
    };
    const st = {
      lastRebalanceAt: "2026-05-10T01:00:00.000Z",
      rebalanceEvents: [_ev1],
    };
    await _handleRebalance(_key, st);
    await _handleRebalance(_key, st);
    assert.strictEqual(_scanCalls.length, 2);
    assert.strictEqual(_logCalls.length, 1);
    assert.strictEqual(_lastRebAt.get(_key), st.lastRebalanceAt);
  });

  it("concurrent in-flight scans dedupe: only one log entry", async () => {
    /*- Two polls fire while the first scan is still in flight.  Both
     *  resolve to ok (server-side `_scanRunning` returns the same
     *  promise).  The first resolution advances the tracker; the
     *  second sees `_lastRebAt[key] === at` and exits before logging
     *  again. */
    _scanImpl = async () => ({ ok: true, added: 1 });
    const st = {
      lastRebalanceAt: "2026-05-10T01:00:00.000Z",
      rebalanceEvents: [_ev1],
    };
    /*- Kick off both before awaiting either, so the tracker check at
     *  the top of the second call sees the same pre-resolution state
     *  as the first. */
    const p1 = _handleRebalance(_key, st);
    const p2 = _handleRebalance(_key, st);
    await Promise.all([p1, p2]);
    assert.strictEqual(_scanCalls.length, 2);
    assert.strictEqual(_logCalls.length, 1);
    assert.strictEqual(_lastRebAt.get(_key), st.lastRebalanceAt);
  });

  it("two distinct rebalances log + advance tracker each time", async () => {
    _scanImpl = async () => ({ ok: true, added: 1 });
    await _handleRebalance(_key, {
      lastRebalanceAt: "2026-05-10T01:00:00.000Z",
      rebalanceEvents: [_ev1],
    });
    await _handleRebalance(_key, {
      lastRebalanceAt: "2026-05-10T02:00:00.000Z",
      rebalanceEvents: [_ev1, _ev2],
    });
    assert.strictEqual(_scanCalls.length, 2);
    assert.strictEqual(_logCalls.length, 2);
    assert.strictEqual(_lastRebAt.get(_key), "2026-05-10T02:00:00.000Z");
  });

  it("scan ok but no rebalanceEvents: tracker still advances, no log", async () => {
    /*- Edge case: server hasn't yet exposed the event detail (e.g. the
     *  event scan is mid-cycle) but `lastRebalanceAt` already advanced.
     *  The scan still runs (the user's pain point — refresh the LP
     *  browser), and the tracker advances so we don't re-fire the
     *  scan every poll waiting for the event to surface.  The log
     *  entry is skipped on this poll; a future poll won't re-log
     *  because the tracker matches. */
    _scanImpl = async () => ({ ok: true, added: 1 });
    await _handleRebalance(_key, {
      lastRebalanceAt: "2026-05-10T01:00:00.000Z",
      rebalanceEvents: [],
    });
    assert.strictEqual(_scanCalls.length, 1);
    assert.strictEqual(_logCalls.length, 0);
    assert.strictEqual(_lastRebAt.get(_key), "2026-05-10T01:00:00.000Z");
  });
});
