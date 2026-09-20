/**
 * @file test/historical-token-price.test.js
 * @description `fetchHistoricalTokenPriceUsd` prices one token on a past
 *   day. It exists for gas, which is spent in the chain's native token
 *   and so belongs to no pool in particular.
 *
 *   The two behaviours worth pinning are the ones a caller depends on
 *   and cannot see: that Moralis is preferred and GeckoTerminal only
 *   covers for it, and that a day is looked up once however many callers
 *   ask. The second is the whole reason the module exists rather than a
 *   bare fetch — a chain of a hundred rebalances must not become a
 *   hundred API calls.
 */

"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const DAY = 1_750_000_000; // a fixed Unix second, so the day key is stable
const TOKEN = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";

let fetchHistoricalTokenPriceUsd;
let calls;
let _moralisAnswer;
let _geckoAnswer;
let _poolAnswer;

/*-
 *  The day cache is held in memory here rather than on disk. The real
 *  one persists, so the first test's answer would be served to every
 *  test after it — and worse, the suite would be writing into the
 *  operator's own price cache. `toUtcDayKey` stays the real one, since
 *  collapsing a timestamp onto its day is exactly what is under test.
 */
const { toUtcDayKey: _realDayKey } = require("../src/price-cache");
let _dayCache;

const _origRequire = Module.prototype.require;

before(() => {
  Module.prototype.require = function (id) {
    if (id === "./price-cache") {
      return {
        toUtcDayKey: _realDayKey,
        getHistoricalPrice: (network, token, key) => {
          const v = _dayCache.get(`${network}|${token}|${key}`);
          return v === undefined ? null : v;
        },
        setHistoricalPrice: (network, token, key, price) => {
          _dayCache.set(`${network}|${token}|${key}`, price);
        },
        flushPriceCache: () => {},
      };
    }
    if (id === "./price-fetcher") {
      return {
        _fetchMoralisHistorical: async (token, block, network) => {
          calls.moralis.push({ token, block, network });
          return _moralisAnswer;
        },
        _fetchGeckoTerminalOhlcv: async (pool, ts, side, network) => {
          calls.gecko.push({ pool, ts, side, network });
          return _geckoAnswer;
        },
      };
    }
    if (id === "./gecko-pool-cache") {
      return {
        getBestPoolForToken: async () => {
          calls.poolLookups++;
          return _poolAnswer;
        },
        flushGeckoPoolCache: () => {},
      };
    }
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/historical-token-price")];
  ({ fetchHistoricalTokenPriceUsd } = require("../src/historical-token-price"));
});

after(() => {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/historical-token-price")];
});

beforeEach(() => {
  calls = { moralis: [], gecko: [], poolLookups: 0 };
  _moralisAnswer = 0;
  _geckoAnswer = 0;
  _poolAnswer = { pool: "0xPool", side: "quote" };
  _dayCache = new Map();
});

describe("fetchHistoricalTokenPriceUsd — source order", () => {
  it("prefers Moralis and does not touch GeckoTerminal when it answers", () => {
    _moralisAnswer = 0.0000117;
    _geckoAnswer = 999; // would be obvious in the result if it were used
    return fetchHistoricalTokenPriceUsd(TOKEN, {
      timestamp: DAY,
      blockNumber: 27_000_000,
    }).then((price) => {
      assert.equal(price, 0.0000117);
      assert.equal(calls.gecko.length, 0, "GeckoTerminal must not be called");
      assert.equal(calls.poolLookups, 0, "no pool need be resolved");
    });
  });

  it("falls through to GeckoTerminal when Moralis has nothing", async () => {
    _moralisAnswer = 0;
    _geckoAnswer = 0.0000122;
    const price = await fetchHistoricalTokenPriceUsd(TOKEN, {
      timestamp: DAY,
      blockNumber: 27_000_000,
    });
    assert.equal(price, 0.0000122);
    assert.equal(calls.moralis.length, 1, "Moralis is still tried first");
  });

  it("reads the side of the pool the token is actually on", async () => {
    /*-
     *  The failure this prevents is not a missing price but a wrong one:
     *  WPLS is the quote token of PLSX/WPLS, so reading `base` returns
     *  PLSX's price under WPLS's name.
     */
    _moralisAnswer = 0;
    _geckoAnswer = 0.0000122;
    /*-
     *  Deliberately `base`, which is NOT the default this file sets up.
     *  With `quote` on both sides an implementation that hard-coded one
     *  value, or ignored the resolved side and let the callee default
     *  apply, would pass and prove nothing.
     */
    _poolAnswer = { pool: "0xHexWpls", side: "base" };
    await fetchHistoricalTokenPriceUsd(TOKEN, { timestamp: DAY });
    assert.equal(calls.gecko[0].side, "base");
    assert.equal(calls.gecko[0].pool, "0xHexWpls");
  });

  it("reads the other side when the token sits there instead", async () => {
    /*-
     *  The pair to the test above. Together they show the side is
     *  carried through rather than fixed.
     */
    _moralisAnswer = 0;
    _geckoAnswer = 0.0000122;
    _poolAnswer = { pool: "0xPlsxWpls", side: "quote" };
    await fetchHistoricalTokenPriceUsd(TOKEN, { timestamp: DAY });
    assert.equal(calls.gecko[0].side, "quote");
  });

  it("skips Moralis entirely when no block is known", async () => {
    /*-
     *  Moralis historical is block-addressed. With no block there is
     *  nothing to ask it, and asking anyway spends a call to be told so.
     */
    _geckoAnswer = 0.5;
    await fetchHistoricalTokenPriceUsd(TOKEN, { timestamp: DAY });
    assert.equal(calls.moralis.length, 0);
    assert.equal(calls.gecko.length, 1);
  });

  it("answers zero when no source can price the day", async () => {
    _moralisAnswer = 0;
    _geckoAnswer = 0;
    const price = await fetchHistoricalTokenPriceUsd(TOKEN, {
      timestamp: DAY,
      blockNumber: 1,
    });
    assert.equal(price, 0);
  });

  it("answers zero when no pool can be resolved", async () => {
    _moralisAnswer = 0;
    _poolAnswer = null;
    const price = await fetchHistoricalTokenPriceUsd(TOKEN, {
      timestamp: DAY,
    });
    assert.equal(price, 0);
    assert.equal(calls.gecko.length, 0, "nothing to read a candle from");
  });

  it("answers zero without calling anything when inputs are missing", async () => {
    assert.equal(await fetchHistoricalTokenPriceUsd(TOKEN, {}), 0);
    assert.equal(await fetchHistoricalTokenPriceUsd("", { timestamp: DAY }), 0);
    assert.equal(calls.moralis.length + calls.gecko.length, 0);
  });
});

describe("fetchHistoricalTokenPriceUsd — one lookup per day", () => {
  it("serves a repeat ask for the same day from cache", async () => {
    /*-
     *  The reason this module is not a bare fetch. A hundred-rebalance
     *  chain asks about the same handful of days over and over.
     */
    _moralisAnswer = 0.0000117;
    const first = await fetchHistoricalTokenPriceUsd(TOKEN, {
      timestamp: DAY,
      blockNumber: 27_000_000,
    });
    const second = await fetchHistoricalTokenPriceUsd(TOKEN, {
      timestamp: DAY + 3600, // later the same UTC day
      blockNumber: 27_000_900, // and a different block
    });
    assert.equal(first, second);
    assert.equal(calls.moralis.length, 1, "the second ask must not refetch");
  });

  it("treats a different day as a different question", async () => {
    _moralisAnswer = 0.0000117;
    await fetchHistoricalTokenPriceUsd(TOKEN, {
      timestamp: DAY,
      blockNumber: 1,
    });
    await fetchHistoricalTokenPriceUsd(TOKEN, {
      timestamp: DAY + 86_400 * 3,
      blockNumber: 2,
    });
    assert.equal(calls.moralis.length, 2);
  });

  it("does not cache a failed lookup", async () => {
    /*-
     *  A zero is the absence of an answer, not an answer of zero.
     *  Caching it would make one bad day permanent.
     */
    _moralisAnswer = 0;
    _geckoAnswer = 0;
    await fetchHistoricalTokenPriceUsd(TOKEN, {
      timestamp: DAY,
      blockNumber: 1,
    });
    _moralisAnswer = 0.0000117;
    const retry = await fetchHistoricalTokenPriceUsd(TOKEN, {
      timestamp: DAY,
      blockNumber: 1,
    });
    assert.equal(retry, 0.0000117, "a retry must be able to succeed");
  });
});
