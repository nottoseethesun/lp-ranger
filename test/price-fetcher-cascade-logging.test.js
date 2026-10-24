/**
 * @file test/price-fetcher-cascade-logging.test.js
 * @description What the current-price cascade in src/lib/price-fetcher.js
 * logs: the source that answered, with the token's address abbreviated;
 * each source that missed and a final "All sources failed"; and nothing
 * at all on a chain no price service covers. Split out of
 * test/price-fetcher.test.js at the 500-line cap.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("node:util");

const { fetchTokenPriceUsd, _cache } = require("../src/lib/price-fetcher");
const {
  _resetForTest: _resetGeckoRateLimit,
} = require("../src/lib/gecko-rate-limit");
const { _setSinkForTests } = require("../src/lib/log");
const config = require("../src/lib/config");
const CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");

const TOKEN = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

let _originalFetch;

beforeEach(() => {
  /*-
   *  TEST-ONLY global swap: each case below replaces `fetch`, because the
   *  price sources ask their services through the global one and offer
   *  no seam for another. The original is captured here and restored
   *  pristine in `afterEach`, after each case's single call.
   */
  _originalFetch = globalThis.fetch;
  _cache.clear();
  _resetGeckoRateLimit();
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
  _cache.clear();
  _resetGeckoRateLimit();
});

/**
 * Run `fn` and hand back every line the cascade logged, formatted,
 * through the logger's own seam rather than the global console.
 */
async function logsOf(fn) {
  const lines = [];
  const restore = _setSinkForTests({
    log: (...a) => lines.push(format(...a)),
    warn: (...a) => lines.push(format(...a)),
  });
  try {
    await fn();
  } finally {
    restore();
  }
  return lines;
}

describe("Cascade logging", () => {
  it("logs the source that succeeded and the abbreviated address", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      /*-
       *  Moralis is asked only with an api key, and tests have none, so
       *  the first service asked is GeckoTerminal, which answers here.
       */
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

    const captured = await logsOf(async () => {
      const price = await fetchTokenPriceUsd(TOKEN);
      assert.strictEqual(price, 0.42);
    });
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
    const captured = await logsOf(async () => {
      const price = await fetchTokenPriceUsd(TOKEN);
      assert.strictEqual(price, 0);
    });
    const flat = captured.join("\n");
    // Each source asked, in turn, names the token and why it missed.
    assert.match(flat, /\] GeckoTerminal error 0xAbCd…Ef01 .*— network down/);
    assert.match(
      flat,
      /\] DexScreener error 0xAbCd…Ef01 .*— network down \(fallback after GeckoTerminal\)/,
    );
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
    let captured;
    try {
      captured = await logsOf(async () => {
        assert.strictEqual(await fetchTokenPriceUsd(TOKEN), 0);
      });
    } finally {
      config.CHAIN = saved;
    }
    assert.strictEqual(calls, 0);
    assert.ok(!captured.join("\n").includes("All sources failed"));
  });
});
