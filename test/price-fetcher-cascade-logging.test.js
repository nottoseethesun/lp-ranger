/**
 * @file test/price-fetcher-cascade-logging.test.js
 * @description What the current-price cascade in src/price-fetcher.js
 * logs: the source that answered, with the token's address abbreviated;
 * each source that missed and a final "All sources failed"; and nothing
 * at all on a chain no price service covers. Split out of
 * test/price-fetcher.test.js at the 500-line cap.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("node:util");

const { fetchTokenPriceUsd, _cache } = require("../src/price-fetcher");
const {
  _resetForTest: _resetGeckoRateLimit,
} = require("../src/gecko-rate-limit");
const config = require("../src/config");
const CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");

const TOKEN = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

let _originalFetch;
let _origLog, _origWarn, captured;

beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _cache.clear();
  _resetGeckoRateLimit();
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
  _cache.clear();
  _resetGeckoRateLimit();
});

/** Start collecting what the cascade writes to the console. */
function startCapture() {
  captured = [];
  _origLog = console.log;
  _origWarn = console.warn;
  console.log = (...a) => captured.push(format(...a));
  console.warn = (...a) => captured.push(format(...a));
}

/** Put the console back. */
function stopCapture() {
  console.log = _origLog;
  console.warn = _origWarn;
}

describe("Cascade logging", () => {
  it("logs the source that succeeded and the abbreviated address", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      // Moralis branch is gated by API key (none in tests) → returns 0.
      // First real call is GeckoTerminal: return a valid price.
      return {
        ok: true,
        json: async () => ({
          data: {
            attributes: {
              token_prices: { [TOKEN.toLowerCase()]: "0.42" },
            },
          },
        }),
      };
    };

    startCapture();
    try {
      const price = await fetchTokenPriceUsd(TOKEN);
      assert.strictEqual(price, 0.42);
    } finally {
      stopCapture();
    }
    // At least one log line should reference the abbreviated token address.
    const flat = captured.join("\n");
    const short = `${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)}`;
    assert.ok(
      flat.includes(short),
      `expected log to contain abbreviated address ${short}\n${flat}`,
    );
    assert.ok(
      flat.includes("GeckoTerminal ok") || flat.includes("DexScreener ok"),
      `expected an "ok" success line\n${flat}`,
    );
    assert.ok(calls >= 1, "should have hit at least one source");
  });

  it("logs miss for each failed source and final 'All sources failed'", async () => {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    startCapture();
    try {
      const price = await fetchTokenPriceUsd(TOKEN);
      assert.strictEqual(price, 0);
    } finally {
      stopCapture();
    }
    const flat = captured.join("\n");
    assert.ok(
      flat.includes("All sources failed"),
      `expected final failure summary\n${flat}`,
    );
  });

  it("asks nothing and reports no failure on a chain no price service covers", async () => {
    /*-
     *  With no service to ask there is no price, and nothing failed; a
     *  "failed" line for every token on every poll would bury the ones
     *  that mean something.
     */
    const saved = config.CHAIN;
    config.CHAIN = CHAINS["pulsechain-testnet"];
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("must not be asked");
    };
    startCapture();
    try {
      assert.strictEqual(await fetchTokenPriceUsd(TOKEN), 0);
    } finally {
      stopCapture();
      config.CHAIN = saved;
    }
    assert.strictEqual(calls, 0);
    assert.ok(!captured.join("\n").includes("All sources failed"));
  });
});
