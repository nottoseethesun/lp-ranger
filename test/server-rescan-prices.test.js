/**
 * @file test/server-rescan-prices.test.js
 * @description
 * Tests for `POST /api/position/rescan-prices` — the narrow, price-only
 * counterpart to Reload Current Position.
 *
 * The behaviours that matter here are the ones that separate it from
 * Reload: it must clear only price-derived keys (leaving the expensive
 * amount-derived ones intact), it must never set `_needsFullRescan`
 * (which would force a from-creation scan and erase the whole cost
 * advantage), it must refuse an unmanaged position, and its window
 * must never resolve to block zero.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createRescanPricesHandler,
  resolveFromBlock,
  parseDays,
  clearPriceDerivedConfig,
  resetPriceState,
  _PRICE_DERIVED_KEYS,
  _BLOCK_TIME_SEC,
} = require("../src/server-rescan-prices");
const { _ON_CHAIN_DERIVED_KEYS } = require("../src/server-reload-position");

// ── window / argument parsing ───────────────────────────────────────────────

test("parseDays — omitted means whole history", () => {
  assert.deepEqual(parseDays({}), { days: null });
  assert.deepEqual(parseDays({ days: null }), { days: null });
  assert.deepEqual(parseDays(undefined), { days: null });
});

test("parseDays — a positive number is accepted", () => {
  assert.deepEqual(parseDays({ days: 60 }), { days: 60 });
  assert.deepEqual(parseDays({ days: "60" }), { days: 60 });
});

test("parseDays — malformed values are rejected, not coerced", () => {
  /*- Silently coercing would let a client bug turn a bounded rescan
   *  into a full-history one, or vice versa. */
  for (const bad of [0, -1, "abc", NaN, Infinity]) {
    const r = parseDays({ days: bad });
    assert.equal(r.error.code, 400, `days=${bad} must be rejected`);
  }
});

test("resolveFromBlock — a day window is measured back from head", async () => {
  const head = 27_000_000;
  const got = await resolveFromBlock(60, head, {});
  const expected = head - Math.round((60 * 24 * 3600) / _BLOCK_TIME_SEC);
  assert.equal(got, expected);
});

test("resolveFromBlock — never returns block zero", async () => {
  /*- Guards the project's no-genesis-scan rule: a window longer than
   *  the chain must clamp to 1, not 0. */
  const got = await resolveFromBlock(100000, 500, {});
  assert.equal(got, 1);
});

test("resolveFromBlock — whole history clamps to at least 1", async () => {
  const got = await resolveFromBlock(null, 27_000_000, {
    token0: "0xA",
    token1: "0xB",
    fee: 2500,
  });
  assert.ok(got >= 1, "must never be 0 even when the resolver fails");
});

// ── what gets cleared ───────────────────────────────────────────────────────

test("price-derived keys are a strict subset of Reload's key set", () => {
  /*- Re-scan Prices clears a subset of what Reload clears.  If this
   *  diverges, it is wiping a key Reload leaves alone, or the two have
   *  stopped sharing a vocabulary for the same state. */
  for (const k of _PRICE_DERIVED_KEYS) {
    assert.ok(
      _ON_CHAIN_DERIVED_KEYS.includes(k),
      `${k} must also be a Reload key`,
    );
  }
  assert.ok(_PRICE_DERIVED_KEYS.length < _ON_CHAIN_DERIVED_KEYS.length);
});

test("amount-derived keys are deliberately NOT cleared", () => {
  /*- Keeping these is the entire cost advantage over Reload. */
  for (const k of [
    "hodlBaseline",
    "lifetimeHodlAmounts",
    "totalLifetimeDepositUsd",
  ]) {
    assert.ok(!_PRICE_DERIVED_KEYS.includes(k), `${k} must be preserved`);
  }
});

test("clearPriceDerivedConfig — drops price keys, keeps the rest", () => {
  const key = "pulsechain-0xW-0xPM-1";
  const diskConfig = {
    positions: {
      [key]: {
        status: "running",
        totalCompoundedUsd: 240.1,
        compoundHistory: [{ usdValue: 240.1 }],
        collectedFeesUsd: 5,
        nftCompoundedUsdByTokenId: { 1: 240.1 },
        hodlBaseline: { hodlAmount0: 1 },
        totalLifetimeDepositUsd: 2500,
        slippagePct: 0.75,
      },
    },
  };
  assert.equal(clearPriceDerivedConfig(diskConfig, key), true);
  const p = diskConfig.positions[key];
  assert.equal(p.totalCompoundedUsd, undefined);
  assert.equal(p.compoundHistory, undefined);
  assert.equal(p.nftCompoundedUsdByTokenId, undefined);
  /*- Preserved: a forward accumulator nothing rebuilds. */
  assert.equal(p.collectedFeesUsd, 5);
  /*- Untouched: */
  assert.deepEqual(p.hodlBaseline, { hodlAmount0: 1 });
  assert.equal(p.totalLifetimeDepositUsd, 2500);
  assert.equal(p.slippagePct, 0.75);
  assert.equal(p.status, "running");
});

test("clearPriceDerivedConfig — unknown key is a no-op returning false", () => {
  assert.equal(clearPriceDerivedConfig({ positions: {} }, "nope"), false);
});

test("resetPriceState — zeroes price fields, never sets _needsFullRescan", () => {
  /*- _needsFullRescan would force a from-pool-creation scan, which is
   *  exactly the hours-long behaviour this route exists to avoid. */
  const st = {
    compoundHistory: [{}],
    totalCompoundedUsd: 240.1,
    collectedFeesUsd: 9,
    nftCompoundedUsdByTokenId: { 1: 2 },
    lifetimeScanComplete: true,
    hodlBaseline: { hodlAmount0: 1 },
  };
  resetPriceState(st);
  assert.deepEqual(st.compoundHistory, []);
  assert.equal(st.totalCompoundedUsd, 0);
  assert.equal(st.collectedFeesUsd, 9, "accumulator must survive");
  assert.deepEqual(st.nftCompoundedUsdByTokenId, {});
  assert.equal(st.lifetimeScanComplete, false);
  assert.equal(st._needsFullRescan, undefined);
  assert.deepEqual(st.hodlBaseline, { hodlAmount0: 1 });
});

test("resetPriceState — tolerates a missing state", () => {
  assert.doesNotThrow(() => resetPriceState(null));
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
  const setCalls = [];
  const handler = createRescanPricesHandler({
    jsonResponse: (_res, code, body) => sent.push({ code, body }),
    readJsonBody: async () => overrides.body ?? { positionKey: key, days: 60 },
    getAllPositionBotStates: () => states,
    /*- resolveLiveKey() calls positionMgr.get / .getAll — a stub
     *  missing them throws rather than resolving. */
    positionMgr: { get: (k) => ({ key: k }), getAll: () => [] },
    walletManager: { getAddress: () => "0xW" },
    diskConfig: { positions: { [key]: posConfig } },
    /*- Shape-checked double.  The real
     *  `epoch-cache.setLastNftScanBlock` destructures a keyOpts OBJECT,
     *  so a double that accepts any argument passes on a handler
     *  passing something else and swallows the TypeError. */
    epochCache: {
      setLastNftScanBlock: (keyOpts, b) => {
        const { blockchain, contract, wallet, token0, token1, fee } = keyOpts;
        if (!token0 || !token1 || fee === undefined)
          throw new TypeError("setLastNftScanBlock needs a keyOpts object");
        setCalls.push([
          { blockchain, contract, wallet, token0, token1, fee },
          b,
        ]);
      },
    },
    getBlockNumber: async () => 27_000_000,
    ...(overrides.deps || {}),
  });
  return { handler, sent, setCalls, state, key };
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
  const h = harness({ body: { days: 60 } });
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 400);
});

test("handler — rejects a malformed days value", async () => {
  const h = harness({
    body: { positionKey: "pulsechain-0xW-0xPM-1", days: -5 },
  });
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 400);
  assert.match(h.sent[0].body.error, /days/);
});

test("handler — success clears price keys and rewinds the watermark", async () => {
  const h = harness();
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 200);
  assert.equal(h.sent[0].body.ok, true);
  assert.equal(h.sent[0].body.days, 60);
  /*- The watermark must be rewound to the window start so the next
   *  lifetime scan re-reads and re-values that range. */
  assert.equal(h.setCalls.length, 1);
  const [keyOpts, block] = h.setCalls[0];
  /*- The epoch-cache key is an OBJECT identifying the pool, not a
   *  string; passing the wrong shape threw inside the real module. */
  assert.equal(keyOpts.token0, "0xA");
  assert.equal(keyOpts.token1, "0xB");
  assert.equal(keyOpts.fee, 2500);
  assert.equal(keyOpts.blockchain, "pulsechain");
  assert.equal(
    block,
    27_000_000 - Math.round((60 * 24 * 3600) / _BLOCK_TIME_SEC),
  );
  assert.equal(h.sent[0].body.fromBlock, block);
  /*- And the in-memory state is reset so the scan re-persists. */
  assert.equal(h.state.totalCompoundedUsd, 0);
  assert.equal(h.state.lifetimeScanComplete, false);
  assert.equal(h.state._needsFullRescan, undefined);
});

test("handler — unchecked window sends the whole history", async () => {
  const key =
    "pulsechain-0x4e44847675763D5540B32Bee8a713CfDcb4bE61A-0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-1";
  const h = harness({ body: { positionKey: key, days: null } });
  await h.handler({}, {});
  assert.equal(h.sent[0].code, 200);
  assert.equal(h.sent[0].body.days, null);
  assert.ok(h.sent[0].body.fromBlock >= 1, "never block zero");
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
  /*- Clearing state alone only takes effect when bot-loop.js's
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

test("resetPriceState — never zeroes the collectedFeesUsd accumulator", () => {
  /*- bot-loop.js seeds it from disk then only ever adds to it; nothing
   *  recomputes it, so zeroing would destroy data irrecoverably. */
  const st = { collectedFeesUsd: 42, totalCompoundedUsd: 240.1 };
  resetPriceState(st);
  assert.equal(st.collectedFeesUsd, 42);
  assert.equal(st.totalCompoundedUsd, 0);
});

test("collectedFeesUsd is not among the cleared config keys", () => {
  assert.ok(!_PRICE_DERIVED_KEYS.includes("collectedFeesUsd"));
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
