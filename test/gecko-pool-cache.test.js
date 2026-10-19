/**
 * @file test/gecko-pool-cache.test.js
 * @description Tests for the GeckoTerminal pool token-orientation cache.
 */

"use strict";

const path = require("path");
const fs = require("fs");

// CRITICAL: redirect cache path BEFORE requiring the module, so tests cannot
// clobber the production file regardless of how they are invoked.
process.env.GECKO_POOL_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  `test-gecko-pool-cache-${process.pid}.json`,
);

const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  getGeckoPoolOrientation,
  flushGeckoPoolCache,
  _resetForTest,
  _CACHE_PATH,
} = require("../src/gecko-pool-cache");
const { _resetForTest: _resetRateLimit } = require("../src/gecko-rate-limit");
const config = require("../src/config");
const { _getDelays, _setDelays } = require("../src/price-source-backoff");

/**
 * Zero the 429 retry schedule for one case through the backoff module's
 * own seam, so its retries run at once, and put the schedule back after.
 * A zero delay also leaves no penalty behind for the next case.
 */
function zeroRetryDelays(t) {
  const schedule = _getDelays();
  _setDelays(schedule.map(() => 0));
  t.after(() => _setDelays(schedule));
}

describe("gecko-pool-cache", () => {
  let _origFetch;

  after(() => {
    try {
      fs.unlinkSync(_CACHE_PATH);
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    _resetForTest();
    _resetRateLimit();
    try {
      fs.unlinkSync(_CACHE_PATH);
    } catch {
      /* ignore */
    }
    /*-
     *  TEST-ONLY global swap: each case below replaces `fetch`, because
     *  the cache asks GeckoTerminal through the global one and offers no
     *  seam for another. The original is captured here and restored
     *  pristine after every case.
     */
    _origFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = _origFetch;
  });

  /** Build a fake GeckoTerminal pool-info response. */
  function _mockPoolResponse(network, baseAddr) {
    return {
      ok: true,
      async json() {
        return {
          data: {
            relationships: {
              base_token: { data: { id: `${network}_${baseAddr}` } },
            },
          },
        };
      },
    };
  }

  it("returns 'normal' when GeckoTerminal base matches token0", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return _mockPoolResponse("pulsechain", "0xtok0");
    };
    const o = await getGeckoPoolOrientation(
      "pulsechain",
      "0xpool",
      "0xTok0",
      "0xTok1",
    );
    assert.equal(o, "normal");
    assert.equal(calls, 1);
  });

  it("returns 'flipped' when GeckoTerminal base matches token1", async () => {
    global.fetch = async () => _mockPoolResponse("pulsechain", "0xtok1");
    const o = await getGeckoPoolOrientation(
      "pulsechain",
      "0xpool",
      "0xTok0",
      "0xTok1",
    );
    assert.equal(o, "flipped");
  });

  it("caches the orientation — second call doesn't hit the network", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return _mockPoolResponse("pulsechain", "0xtok0");
    };
    await getGeckoPoolOrientation("pulsechain", "0xpool", "0xtok0", "0xtok1");
    await getGeckoPoolOrientation("pulsechain", "0xpool", "0xtok0", "0xtok1");
    assert.equal(calls, 1);
  });

  it("keeps one chain's orientation from answering for another chain", async () => {
    /*-
     *  Keyed by the active chain, not by the service's name for the
     *  network: the same address can be another pool on another chain.
     */
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return _mockPoolResponse("pulsechain", "0xtok0");
    };
    await getGeckoPoolOrientation("pulsechain", "0xpool", "0xtok0", "0xtok1");
    const chain = config.CHAIN_NAME;
    try {
      config.CHAIN_NAME = "pulsechain-testnet";
      await getGeckoPoolOrientation("pulsechain", "0xpool", "0xtok0", "0xtok1");
      assert.equal(calls, 2, "the other chain asked for itself");
    } finally {
      config.CHAIN_NAME = chain;
    }
    await getGeckoPoolOrientation("pulsechain", "0xpool", "0xtok0", "0xtok1");
    assert.equal(calls, 2, "the first chain's answer was kept");
  });

  it("returns null when GeckoTerminal base matches neither token", async () => {
    global.fetch = async () => _mockPoolResponse("pulsechain", "0xother");
    const o = await getGeckoPoolOrientation(
      "pulsechain",
      "0xpool",
      "0xtok0",
      "0xtok1",
    );
    assert.equal(o, null);
  });

  it("returns null when fetch fails (HTTP error)", async () => {
    global.fetch = async () => ({ ok: false, status: 404, async json() {} });
    const o = await getGeckoPoolOrientation(
      "pulsechain",
      "0xpool",
      "0xtok0",
      "0xtok1",
    );
    assert.equal(o, null);
  });

  it("retries on 429, then succeeds on second attempt", async (t) => {
    zeroRetryDelays(t);
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, async json() {} };
      return _mockPoolResponse("pulsechain", "0xtok0");
    };
    const o = await getGeckoPoolOrientation(
      "pulsechain",
      "0xpool",
      "0xtok0",
      "0xtok1",
    );
    assert.equal(o, "normal");
    assert.equal(calls, 2, "should have retried once");
  });

  it("returns null after all 429 retries exhausted", async (t) => {
    zeroRetryDelays(t);
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 429, async json() {} };
    };
    const o = await getGeckoPoolOrientation(
      "pulsechain",
      "0xpool",
      "0xtok0",
      "0xtok1",
    );
    assert.equal(o, null);
    /*- The schedule belongs to price-source-backoff.js, shared with the
     *  OHLCV caller, so the count is read from it rather than restated
     *  here — a second copy of the number goes stale the moment the
     *  schedule is retuned, and reports it as a pool-cache failure. */
    const expected = _getDelays().length + 1;
    assert.equal(
      calls,
      expected,
      `should retry ${_getDelays().length} times on 429 then give up`,
    );
  });

  it("returns null when fetch throws", async () => {
    global.fetch = async () => {
      throw new Error("network down");
    };
    const o = await getGeckoPoolOrientation(
      "pulsechain",
      "0xpool",
      "0xtok0",
      "0xtok1",
    );
    assert.equal(o, null);
  });

  it("returns null when called with missing args", async () => {
    assert.equal(
      await getGeckoPoolOrientation("", "0xp", "0xt0", "0xt1"),
      null,
    );
    assert.equal(
      await getGeckoPoolOrientation("pulsechain", "", "0xt0", "0xt1"),
      null,
    );
  });

  it("flush persists cache and survives reload", async () => {
    global.fetch = async () => _mockPoolResponse("pulsechain", "0xtok0");
    await getGeckoPoolOrientation("pulsechain", "0xpool", "0xtok0", "0xtok1");
    flushGeckoPoolCache();
    _resetForTest();
    let called = false;
    global.fetch = async () => {
      called = true;
      return _mockPoolResponse("pulsechain", "0xtok0");
    };
    const o = await getGeckoPoolOrientation(
      "pulsechain",
      "0xpool",
      "0xtok0",
      "0xtok1",
    );
    assert.equal(o, "normal");
    assert.equal(called, false, "should not re-fetch after reload");
  });

  it("isolates entries by network and pool", async () => {
    let count = 0;
    const baseByCall = ["0xtok0", "0xtok1"];
    global.fetch = async () =>
      _mockPoolResponse("pulsechain", baseByCall[count++]);
    const a = await getGeckoPoolOrientation(
      "pulsechain",
      "0xpoolA",
      "0xtok0",
      "0xtok1",
    );
    const b = await getGeckoPoolOrientation(
      "pulsechain",
      "0xpoolB",
      "0xtok0",
      "0xtok1",
    );
    assert.equal(a, "normal");
    assert.equal(b, "flipped");
  });
});
