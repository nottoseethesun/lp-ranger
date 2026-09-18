/**
 * @file test/server-rescan-prices.test.js
 * @description
 * Tests for `POST /api/position/rescan-prices` — the narrow, price-only
 * counterpart to Reload Current Position.
 *
 * The behaviours that matter here are the ones that separate it from
 * Reload: it deletes nothing, it asks the scan to re-value every stored
 * figure at fresh prices, it must never set `_needsFullRescan` (which
 * would also re-derive the token amounts, the expensive part of Reload),
 * and it must refuse an unmanaged position.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createRescanPricesHandler,
  requestPriceRevalue,
} = require("../src/server-rescan-prices");

// ── what the request does to state ──────────────────────────────────────────

test("requestPriceRevalue — asks for the re-value, deletes nothing", () => {
  /*-
   *  Deleting first left a window: the figure was missing until the scan
   *  rebuilt it, a rebalance's fee credit could land in that window, and
   *  the scan's "already saved" guard then kept the partial number.
   */
  const st = {
    compoundHistory: [{ usdValue: 240.1 }],
    compoundedAmount0: 240.1,
    compoundedAmount1: 12,
    nftCompoundedAmountsByTokenId: { 1: { amount0: 2, amount1: 1 } },
    totalLifetimeDepositUsd: 2500,
    lifetimeScanComplete: true,
    hodlBaseline: { hodlAmount0: 1 },
  };
  requestPriceRevalue(st);
  assert.equal(st._needsPriceRevalue, true);
  assert.equal(st.lifetimeScanComplete, false, "the Lifetime panel syncs");
  assert.deepEqual(st.compoundHistory, [{ usdValue: 240.1 }]);
  /*- The compounded COINS, which are what the position stores; the
   *  dollars are priced wherever they are shown. */
  assert.equal(st.compoundedAmount0, 240.1);
  assert.equal(st.compoundedAmount1, 12);
  assert.deepEqual(st.nftCompoundedAmountsByTokenId, {
    1: { amount0: 2, amount1: 1 },
  });
  assert.equal(st.totalLifetimeDepositUsd, 2500);
  assert.deepEqual(st.hodlBaseline, { hodlAmount0: 1 });
  /*-
   *  _needsFullRescan would also re-derive the token amounts from the
   *  pool's history, which is what makes Reload slow.
   */
  assert.equal(st._needsFullRescan, undefined);
});

test("requestPriceRevalue — tolerates a missing state", () => {
  assert.doesNotThrow(() => requestPriceRevalue(null));
});

// ── handler ─────────────────────────────────────────────────────────────────

function harness(overrides = {}) {
  const sent = [];
  const key =
    "pulsechain-0x4e44847675763D5540B32Bee8a713CfDcb4bE61A-0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-1";
  /*- Real shape: `status` lives on the DISK CONFIG, never on the bot
   *  state.  `build-status-positions.js` merges the two for the API
   *  response, which is why the dashboard sees it.  A harness that puts
   *  `status` on the state instead supplies the field the code under
   *  test is failing to find, and passes on input the app never
   *  produces. */
  const state = {
    activePosition: { tokenId: "1", token0: "0xA", token1: "0xB", fee: 2500 },
    ...(overrides.state || {}),
  };
  const states = new Map([[key, state]]);
  const posConfig = {
    status: "running",
    totalCompoundedUsd: 240.1,
    ...(overrides.posConfig || {}),
  };
  const handler = createRescanPricesHandler({
    jsonResponse: (_res, code, body) => sent.push({ code, body }),
    readJsonBody: async () => overrides.body ?? { positionKey: key },
    getAllPositionBotStates: () => states,
    /*- resolveLiveKey() calls positionMgr.get / .getAll — a stub
     *  missing them throws rather than resolving. */
    positionMgr: { get: (k) => ({ key: k }), getAll: () => [] },
    walletManager: { getAddress: () => "0xW" },
    diskConfig: { positions: { [key]: posConfig } },
  });
  return { handler, sent, state, posConfig };
}

test("handler — refuses a position that is not managed", async () => {
  const h = harness({ posConfig: { status: "stopped" } });
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 409);
  assert.equal(h.sent[0].body.error, "not-managed");
  assert.match(h.sent[0].body.message, /Manage/);
});

test("handler — refuses while a rebalance is in flight", async () => {
  const h = harness({ state: { rebalanceInProgress: true } });
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 409);
  assert.equal(h.sent[0].body.error, "rebalance-in-progress");
});

test("handler — rejects a missing positionKey", async () => {
  const h = harness({ body: {} });
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 400);
});

test("handler — success asks for the re-value and keeps every figure", async () => {
  const h = harness();
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 200);
  const fields = Object.keys(h.sent[0].body).sort();
  assert.deepEqual(
    fields,
    ["liveKey", "message", "ok"],
    "the response docs/openapi.json describes",
  );
  assert.equal(h.sent[0].body.ok, true);
  assert.equal(h.posConfig.totalCompoundedUsd, 240.1, "saved figure kept");
  assert.equal(h.posConfig.status, "running", "settings kept");
  assert.equal(h.state._needsPriceRevalue, true);
  assert.equal(h.state.lifetimeScanComplete, false);
  assert.equal(h.state._needsFullRescan, undefined);
});

test("handler — accepts a managed position (status lives on config)", async () => {
  /*- Regression guard for the 409-on-every-managed-position bug: the
   *  handler read `state.status`, which is always undefined.  A bot
   *  state with no `status` at all must still be accepted when the
   *  disk config says "running". */
  const h = harness({ state: {}, posConfig: { status: "running" } });
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 200, "a managed position must not be refused");
  assert.equal(h.sent[0].body.ok, true);
});

test("handler — triggers the scan immediately, not on the 30-min timer", async () => {
  /*- Setting the request alone only takes effect when bot-loop.js's
   *  LIFETIME_RESCAN_CHECK_MS timer next fires, so the button would
   *  report success and appear to do nothing for up to half an hour. */
  let triggered = 0;
  const h = harness({
    state: {
      _triggerScan: async () => {
        triggered++;
      },
    },
  });
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 200);
  assert.equal(triggered, 1, "must call _triggerScan");
});

test("handler — survives a position with no _triggerScan", async () => {
  const h = harness({ state: {} });
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 200);
});

test("handler — 409 copy names THIS feature, not Reload", async () => {
  /*- The shared guard defaults to Reload's wording; unparameterised it
   *  told users to wait before a "Reload Current Position" that "can
   *  take up to four hours". */
  const scan = harness({ state: { _scanRunning: true } });
  await scan.handler({}, {});
  const m = scan.sent[0].body.message;
  assert.match(m, /Re-scan Prices/);
  assert.doesNotMatch(m, /Reload Current Position/);
  assert.doesNotMatch(m, /four hours/);

  const reb = harness({ state: { rebalanceInProgress: true } });
  await reb.handler({}, {});
  assert.match(reb.sent[0].body.message, /re-scan prices for this position/);
  assert.doesNotMatch(reb.sent[0].body.message, /Cannot reload/);
});
