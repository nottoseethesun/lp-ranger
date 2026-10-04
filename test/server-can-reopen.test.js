/**
 * @file test/server-can-reopen.test.js
 * @description Unit tests for `src/server-can-reopen.js` — the
 *   `POST /api/position/can-reopen` handler used by the dashboard's
 *   closed-position Manage flow to verify the wallet holds enough of
 *   at least one pair token to seed a re-open rebalance.
 *
 *   Covers:
 *     - 400 when wallet not loaded
 *     - 400 when token0/token1 missing from body
 *     - 200 + canReopen=true when EITHER token > dust
 *     - 200 + canReopen=false when BOTH tokens are dust
 *     - 500 when the on-chain reader throws
 *     - response shape (balances per-token, isDust flag, threshold)
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const {
  createCanReopenHandler,
  _setRetryDelayForTests,
} = require("../src/server-can-reopen");

/*- Shrink the inter-retry delay to zero so the exhaustion test
 *  (4 attempts) completes in milliseconds rather than ~10 seconds. */
_setRetryDelayForTests(0);
const {
  createPositionRoutes,
  getAllPositionBotStates,
} = require("../src/server-positions");
const { compositeKey } = require("../src/bot-config-v2");
const config = require("../src/config");
const logModule = require("../src/log");
const sendTx = require("../src/send-transaction");
const { condemn } = require("./helpers/send-tx-stubs");
const { format } = require("node:util");

const TOKEN0 = "0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b";
const TOKEN1 = "0xAEbcD0F8f69ECF9587e292bdfc4d731c1abedB68";
const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";

/*- The balance read takes its endpoint from the app's failover, so the
 *  rpc layer has to be stood up here as `server.js` stands it up at
 *  boot.  The provider itself is never exercised.
 *
 *  Per test, not once for the file.  Each case that exhausts its retry
 *  budget reports failures, which walks selection along the endpoint
 *  list and leaves it there for whatever runs next — and a case starting
 *  from the END of the list cannot observe a further move at all, so it
 *  would pass whether or not the thing it asserts is true.  The decider
 *  is reset with it, since a crossed failure rate carries over the same
 *  way. */
beforeEach(() => {
  sendTx._resetForTests();
  require("../src/rpc-out-of-service")._resetForTests();
  /*- The real endpoint list, so the retry budget spans as many endpoints
   *  here as it does in production.  No network is reached: the stub
   *  constructor returns a bare object and every case injects both
   *  `readBalance` and `fetchPrice`. */
  sendTx.init(
    { urls: [...config.RPC_URLS] },
    {
      JsonRpcProvider: function () {
        return {};
      },
    },
  );
});
afterEach(() => {
  sendTx._resetForTests();
  require("../src/rpc-out-of-service")._resetForTests();
});

function makeRes() {
  return { _status: null, _body: null };
}
function makeDeps(overrides = {}) {
  return {
    walletManager: { getAddress: () => WALLET },
    jsonResponse: (res, status, body) => {
      res._status = status;
      res._body = body;
    },
    readJsonBody: async () => overrides.body || {},
    getDust: async () => ({ thresholdUsd: 0.5 }),
    /*- Injected so no case reaches the real price fetcher, which is
     *  HTTP against a quota-limited API.  It used to sit behind the
     *  injected `readBalance`; now that the handler asks for prices
     *  itself, the seam has to be stubbed here. */
    fetchPrice: async () => 1,
    readBalance: overrides.readBalance,
    ...overrides,
  };
}

describe("handleCanReopen", () => {
  it("returns 400 when wallet not loaded", async () => {
    const deps = makeDeps({
      walletManager: { getAddress: () => null },
      body: { token0: TOKEN0, token1: TOKEN1 },
    });
    const handler = createCanReopenHandler(deps);
    const res = makeRes();
    await handler({}, res);
    assert.strictEqual(res._status, 400);
    assert.match(res._body.error, /wallet not loaded/);
  });

  it("returns 400 when token0 / token1 missing from body", async () => {
    for (const bad of [{}, { token0: TOKEN0 }, { token1: TOKEN1 }]) {
      const deps = makeDeps({ body: bad });
      const handler = createCanReopenHandler(deps);
      const res = makeRes();
      await handler({}, res);
      assert.strictEqual(res._status, 400);
      assert.match(res._body.error, /token0 and token1 are required/);
    }
  });

  it("returns 200 canReopen=true when EITHER token > dust", async () => {
    /*- token0 is well-funded ($10), token1 is dust ($0.01).  Wallet
     *  qualifies to re-open because >=1 token is above the threshold. */
    const deps = makeDeps({
      body: {
        token0: TOKEN0,
        token1: TOKEN1,
        token0Symbol: "CRO",
        token1Symbol: "dickwifbutt",
      },
      readBalance: async ({ address, thresholdUsd }) => {
        if (address === TOKEN0)
          return {
            symbol: "CRO",
            decimals: 8,
            raw: "1000000000",
            amount: 10,
            usd: 10.0,
            isDust: 10.0 <= thresholdUsd,
          };
        return {
          symbol: "dickwifbutt",
          decimals: 18,
          raw: "10000000000000000",
          amount: 0.01,
          usd: 0.01,
          isDust: 0.01 <= thresholdUsd,
        };
      },
    });
    const handler = createCanReopenHandler(deps);
    const res = makeRes();
    await handler({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.ok, true);
    assert.strictEqual(res._body.canReopen, true);
    assert.strictEqual(res._body.dustThresholdUsd, 0.5);
    assert.strictEqual(res._body.balances.token0.symbol, "CRO");
    assert.strictEqual(res._body.balances.token0.usd, 10);
    assert.strictEqual(res._body.balances.token0.isDust, false);
    assert.strictEqual(res._body.balances.token1.symbol, "dickwifbutt");
    assert.strictEqual(res._body.balances.token1.usd, 0.01);
    assert.strictEqual(res._body.balances.token1.isDust, true);
  });

  it("returns 200 canReopen=false when BOTH tokens are dust", async () => {
    /*- Both tokens below the $0.50 threshold → user can't re-open
     *  until they fund the wallet.  Response still includes per-token
     *  balances so the dashboard can show them in the modal. */
    const deps = makeDeps({
      body: { token0: TOKEN0, token1: TOKEN1 },
      readBalance: async ({ address, thresholdUsd }) => ({
        symbol: address === TOKEN0 ? "CRO" : "dickwifbutt",
        decimals: address === TOKEN0 ? 8 : 18,
        raw: "1",
        amount: 1e-8,
        usd: 0.01,
        isDust: 0.01 <= thresholdUsd,
      }),
    });
    const handler = createCanReopenHandler(deps);
    const res = makeRes();
    await handler({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.canReopen, false);
    assert.strictEqual(res._body.balances.token0.isDust, true);
    assert.strictEqual(res._body.balances.token1.isDust, true);
  });

  it("returns 200 canReopen=true when BOTH tokens are well above dust", async () => {
    const deps = makeDeps({
      body: { token0: TOKEN0, token1: TOKEN1 },
      readBalance: async () => ({
        symbol: "X",
        decimals: 18,
        raw: "1000000000000000000000",
        amount: 1000,
        usd: 5000,
        isDust: false,
      }),
    });
    const handler = createCanReopenHandler(deps);
    const res = makeRes();
    await handler({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.canReopen, true);
  });

  it("returns 503 wallet-read-unavailable after exhausting RPC retries", async () => {
    /*- A persistent on-chain read failure (RPC outage, Moralis down,
     *  contract revert on `balanceOf`) is retried twice per RPC
     *  across every configured RPC.  On exhaustion the
     *  handler throws `WalletReadUnavailableError` which maps to a
     *  503 with the structured `wallet-read-unavailable` code.  The
     *  dashboard's `runReopenFlow` recognizes the code and shows
     *  the dedicated "try again in 10+ minutes" modal. */
    let calls = 0;
    const deps = makeDeps({
      body: { token0: TOKEN0, token1: TOKEN1 },
      readBalance: async () => {
        calls++;
        throw new Error("simulated RPC outage");
      },
    });
    const handler = createCanReopenHandler(deps);
    const res = makeRes();
    await handler({}, res);
    assert.strictEqual(res._status, 503);
    assert.strictEqual(res._body.error, "wallet-read-unavailable");
    assert.match(res._body.message, /Wallet read failed after \d+ attempt/);
    assert.match(res._body.message, /simulated RPC outage/);
    /*- Endpoints in service x 2 attempts each x 2 tokens per attempt
     *  (one `Promise.all`).  Read from `sendTx`, which is where the
     *  budget itself comes from, so the two cannot pass for different
     *  reasons; what is guarded is that the whole budget is spent, not
     *  any particular total. */
    const expected = sendTx.endpointCount() * 2 * 2;
    assert.strictEqual(
      calls,
      expected,
      `expected ${expected} readBalance calls (RPCs x 2 attempts x 2 tokens), got ${calls}`,
    );
  });

  it("recovers + returns 200 when readBalance succeeds on a later attempt", async () => {
    /*- Transient RPC blip: first attempt's first token throws,
     *  retries succeed.  Verifies the orchestrator short-circuits
     *  the loop on success and doesn't waste the rest of the budget. */
    let attemptCount = 0;
    const goodReadBalance = async ({ address }) => ({
      symbol: address === TOKEN0 ? "CRO" : "dickwifbutt",
      decimals: 18,
      raw: "1000000000000000000000",
      amount: 1000,
      usd: 5000,
      isDust: false,
    });
    const deps = makeDeps({
      body: { token0: TOKEN0, token1: TOKEN1 },
      readBalance: async (args) => {
        attemptCount++;
        if (attemptCount <= 2) throw new Error("transient blip");
        return goodReadBalance(args);
      },
    });
    const handler = createCanReopenHandler(deps);
    const res = makeRes();
    /*- Each failed attempt above writes a warning, so the recovery has
     *  to write one too: a run of warnings that simply stops reads the
     *  same as giving up, and an operator is left guessing whether the
     *  balances were ever read. */
    const said = [];
    const restore = logModule._setSinkForTests({
      log: (...a) => said.push(format(...a)),
    });
    try {
      await handler({}, res);
    } finally {
      restore();
    }
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.canReopen, true);

    const recovery = said.filter((l) => l.includes("read ok on"));
    assert.strictEqual(recovery.length, 1, "exactly one recovery line");
    assert.ok(
      recovery[0].includes("[can-reopen]"),
      `the line must name this reader, got: ${recovery[0]}`,
    );
    assert.ok(
      recovery[0].includes("failed attempt"),
      "and how many attempts failed first",
    );
  });

  it("asks the price API once per token, not once per rpc attempt", async () => {
    /*- The price lookup takes a token address and asks an HTTP API; no
     *  provider is involved.  Inside the retried unit an rpc outage
     *  re-asked it once per attempt, against a quota the rest of the
     *  app rations with an idle pause. */
    let priceCalls = 0;
    let readCalls = 0;
    const deps = makeDeps({
      body: { token0: TOKEN0, token1: TOKEN1 },
      fetchPrice: async () => {
        priceCalls++;
        return 1;
      },
      readBalance: async () => {
        readCalls++;
        throw new Error("simulated RPC outage");
      },
    });
    const res = makeRes();
    await createCanReopenHandler(deps)({}, res);

    assert.strictEqual(res._status, 503, "the rpc reads were exhausted");
    assert.ok(readCalls > 2, `the budget was spent, got ${readCalls}`);
    assert.strictEqual(
      priceCalls,
      2,
      `one lookup per token, whatever the rpc retries did; got ${priceCalls}`,
    );
  });

  it("a price-API failure leaves the rpc endpoint alone", async () => {
    /*- A price API being down says nothing about the endpoint, so it
     *  must not move one.  A guard against a future change rather than
     *  a reproduction of a past one: with the lookup hoisted out of the
     *  retried unit a price failure cannot reach the failover report at
     *  all, and putting it back inside would have to get past this.
     *
     *  The rate is put over the threshold first, so that a report of a
     *  failure WOULD move selection — otherwise the case passes because
     *  nothing moves under the threshold, whatever was reported. */
    const before = sendTx.getCurrentRPCUrl();
    /*- The rate is put over the threshold first, so that a report of a
     *  failure would actually move selection.  Without this the case
     *  passes for the wrong reason — nothing moves while the rate is
     *  under, whether or not the failure was reported. */
    condemn(before);
    const deps = makeDeps({
      body: { token0: TOKEN0, token1: TOKEN1 },
      fetchPrice: async () => {
        throw new Error("Moralis 503");
      },
      readBalance: async () => {
        throw new Error("readBalance must not be reached");
      },
    });
    const res = makeRes();
    await createCanReopenHandler(deps)({}, res);

    assert.strictEqual(
      sendTx.getCurrentRPCUrl(),
      before,
      "a price failure must not move rpc selection",
    );
    /*- Still the operator's 503: without a price they cannot be told
     *  whether they have enough to re-open. */
    assert.strictEqual(res._status, 503);
    assert.strictEqual(res._body.error, "wallet-read-unavailable");
  });

  it("partial failure (one token throws) counts as complete attempt failure", async () => {
    /*- Per the user's spec: if either token's read fails, the whole
     *  attempt fails.  Don't mix verified + unverified balances in
     *  the response.  Here token0 always fails but token1 always
     *  succeeds — the Promise.all rejects, the orchestrator retries
     *  4 times, all fail the same way, response is 503. */
    const deps = makeDeps({
      body: { token0: TOKEN0, token1: TOKEN1 },
      readBalance: async ({ address }) => {
        if (address === TOKEN0) throw new Error("token0 unreadable");
        return {
          symbol: "T1",
          decimals: 18,
          raw: "1000000000000000000",
          amount: 1,
          usd: 100,
          isDust: false,
        };
      },
    });
    const handler = createCanReopenHandler(deps);
    const res = makeRes();
    await handler({}, res);
    assert.strictEqual(res._status, 503);
    assert.strictEqual(res._body.error, "wallet-read-unavailable");
    assert.match(res._body.message, /token0 unreadable/);
  });
});

// ── handleManage re-open flag propagation ─────────────────────────────────

/*- Minimal helpers mirroring test/server-positions.test.js so this file
 *  stays self-contained without depending on extracting them upstream. */
function _makeDiskConfig(overrides = {}) {
  return { global: {}, positions: {}, ...overrides };
}
function _makePositionMgr(overrides = {}) {
  return {
    runningCount: () => 0,
    count: () => 0,
    stopAll: async () => {},
    startPosition: async () => {},
    removePosition: async () => {},
    get: () => null,
    getAll: () => [],
    migrateKey: () => {},
    getRebalanceLock: () => ({ acquire: async () => () => {} }),
    getScanLock: () => ({ acquire: async () => () => {} }),
    poolKey: () => "pool",
    canRebalancePool: () => true,
    recordPoolRebalance: () => {},
    getSharedSigner: async () => ({
      provider: {},
      signer: { getAddress: async () => "0xAA" },
      address: "0xAA",
    }),
    ...overrides,
  };
}
function _makeRouteDeps(overrides = {}) {
  return {
    diskConfig: _makeDiskConfig(),
    positionMgr: _makePositionMgr(),
    walletManager: {
      getAddress: () => WALLET,
      getStatus: () => ({ loaded: true, address: WALLET }),
    },
    getPrivateKey: () => "0xpk123",
    jsonResponse: (res, status, body) => {
      res._status = status;
      res._body = body;
    },
    readJsonBody: async () => ({}),
    ...overrides,
  };
}

describe("handleManage re-open flag propagation", () => {
  it("stamps forceRebalance on posBotState BEFORE startPosition fires (re-open path)", async () => {
    /*- When the dashboard re-opens a closed position via Manage, it
     *  POSTs `{ forceRebalance: true }` alongside `tokenId`.  Server
     *  must apply the flag to the freshly-built posBotState BEFORE
     *  `startPosition` runs the bot loop's first poll — otherwise
     *  `bot-cycle-drain.js`'s drain guard would re-arm the 30-min
     *  retire timer instead of letting the rebalance pipeline run on
     *  the drained NFT.
     *
     *  As of the "Migrate Rebalance UI dialog into Bot Settings" plan,
     *  the range-width override is a persistent per-position config
     *  key (`rebalanceRangeWidthPct` POSITION_KEY) — no longer sent in
     *  the request body and no longer stamped on state.  Even if a
     *  stale caller sends `customRangeWidthPct` in the body, this
     *  test asserts state stays clean of it. */
    let stateAtStartPosition = null;
    const dc = _makeDiskConfig();
    const deps = _makeRouteDeps({
      diskConfig: dc,
      readJsonBody: async () => ({
        tokenId: "158970",
        forceRebalance: true,
        /*- Stale field a legacy client might still send; MUST NOT
         *  leak onto state. */
        customRangeWidthPct: 7.5,
      }),
      positionMgr: _makePositionMgr({
        get: () => null,
        startPosition: async (key) => {
          stateAtStartPosition = {
            ...getAllPositionBotStates().get(key),
          };
        },
      }),
    });
    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["POST /api/position/manage"]({}, res);
    assert.strictEqual(res._status, 200);
    assert.ok(stateAtStartPosition, "startPosition should have been called");
    assert.strictEqual(
      stateAtStartPosition.forceRebalance,
      true,
      "forceRebalance must be on posBotState at startPosition call time",
    );
    assert.strictEqual(
      stateAtStartPosition.customRangeWidthPct,
      undefined,
      "customRangeWidthPct must NOT leak from body onto state — read from config now",
    );

    const key = Object.keys(dc.positions).find((k) => k.endsWith("-158970"));
    if (key) getAllPositionBotStates().delete(key);
  });

  it("does NOT stamp forceRebalance for a normal Manage (healthy position) call", async () => {
    /*- Healthy unmanaged position → user clicks Manage normally → no
     *  forceRebalance in the body → posBotState comes up clean. */
    let stateAtStartPosition = null;
    const dc = _makeDiskConfig();
    const deps = _makeRouteDeps({
      diskConfig: dc,
      readJsonBody: async () => ({ tokenId: "42" }),
      positionMgr: _makePositionMgr({
        get: () => null,
        startPosition: async (key) => {
          stateAtStartPosition = {
            ...getAllPositionBotStates().get(key),
          };
        },
      }),
    });
    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["POST /api/position/manage"]({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(
      stateAtStartPosition.forceRebalance,
      undefined,
      "forceRebalance should remain unset on normal Manage",
    );
    assert.strictEqual(
      stateAtStartPosition.customRangeWidthPct,
      undefined,
      "customRangeWidthPct should remain unset on normal Manage",
    );
    const key = Object.keys(dc.positions).find((k) => k.endsWith("-42"));
    if (key) getAllPositionBotStates().delete(key);
  });

  it("stamps forceRebalance + clears paused state on already-running position (retry path)", async () => {
    /*- User clicks Manage on a closed-but-running position to retry
     *  after the previous re-open's swap aborted on slippage.
     *  handleManage's "already running — skipping" short-circuit must
     *  route through `_stampReopenFlagsOnLive` so the flag is wired
     *  through to the live posBotState AND the paused/midway state
     *  cleared, otherwise the bot would keep returning early at the
     *  rebalancePaused gate in `_checkRebalanceGates` and the retry
     *  would never fire. */
    const dc = _makeDiskConfig();
    const liveKey = compositeKey(
      "pulsechain",
      WALLET,
      config.POSITION_MANAGER,
      "99999",
    );
    /*- Pre-populate _positionBotStates with a paused live state,
     *  including `_retireImmediately: true` (set by bot-loop.js's
     *  re-open-failure path).  All these flags must be cleared by
     *  `_stampReopenFlagsOnLive` so the retry can actually run on
     *  the next poll instead of being preempted by drain.js's
     *  immediate-retire branch. */
    const liveState = {
      rebalancePaused: true,
      rebalanceFailedMidway: true,
      rebalanceError: "Swap aborted: price impact 2.4% exceeds slippage 0.75%",
      _retireImmediately: true,
    };
    getAllPositionBotStates().set(liveKey, liveState);
    let startPositionCalled = false;
    const deps = _makeRouteDeps({
      diskConfig: dc,
      readJsonBody: async () => ({
        tokenId: "99999",
        forceRebalance: true,
        /*- Stale legacy field: must not leak onto state.  Range width
         *  comes from the persistent `rebalanceRangeWidthPct`
         *  POSITION_KEY, read by `bot-cycle-opts.js` via
         *  `deps._getConfig`. */
        customRangeWidthPct: 12,
      }),
      positionMgr: _makePositionMgr({
        get: (k) => (k === liveKey ? { status: "running" } : null),
        startPosition: async () => {
          startPositionCalled = true;
        },
      }),
    });
    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["POST /api/position/manage"]({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(
      res._body.alreadyRunning,
      true,
      "should report alreadyRunning=true",
    );
    assert.strictEqual(
      res._body.reopenStamped,
      true,
      "should report reopenStamped=true",
    );
    assert.strictEqual(
      startPositionCalled,
      false,
      "must NOT start a second bot loop",
    );
    assert.strictEqual(liveState.forceRebalance, true);
    assert.strictEqual(
      liveState.customRangeWidthPct,
      undefined,
      "customRangeWidthPct must NOT leak from body onto live state",
    );
    assert.strictEqual(liveState.rebalancePaused, false);
    assert.strictEqual(liveState.rebalanceFailedMidway, false);
    assert.strictEqual(liveState.rebalanceError, null);
    /*- Regression: _retireImmediately must be cleared too.  If the
     *  prior re-open failure set it (bot-loop.js's `_handleError`),
     *  drain.js would fire retire on the next poll BEFORE the
     *  forceRebalance can take effect, silently losing the user's
     *  retry click. */
    assert.strictEqual(liveState._retireImmediately, false);
    getAllPositionBotStates().delete(liveKey);
  });

  it("does NOT stamp anything when forceRebalance is absent on already-running position", async () => {
    /*- Plain Manage click on an already-running position should still
     *  no-op (no flag carry-over from a stale request).  reopenStamped
     *  must be false. */
    const dc = _makeDiskConfig();
    const liveKey = compositeKey(
      "pulsechain",
      WALLET,
      config.POSITION_MANAGER,
      "88888",
    );
    const liveState = { rebalancePaused: false };
    getAllPositionBotStates().set(liveKey, liveState);
    const deps = _makeRouteDeps({
      diskConfig: dc,
      readJsonBody: async () => ({ tokenId: "88888" }),
      positionMgr: _makePositionMgr({
        get: (k) => (k === liveKey ? { status: "running" } : null),
      }),
    });
    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["POST /api/position/manage"]({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.alreadyRunning, true);
    assert.strictEqual(res._body.reopenStamped, false);
    assert.strictEqual(liveState.forceRebalance, undefined);
    getAllPositionBotStates().delete(liveKey);
  });
});
