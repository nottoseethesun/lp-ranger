/**
 * @file test/bot-cycle-compound-fresh-fees.test.js
 * @description The compound decision values fees at current prices.
 *
 * Auto-compound fires when unclaimed fees clear a USD threshold. The
 * poll's own figure is computed with whatever prices that poll had, and
 * the idle pause answers a price read from cache with no age limit — or
 * with nothing at all on a process that has never fetched one, which is
 * every headless `npm run bot` start, since it pauses at startup and
 * only browser activity lifts the pause.
 *
 * So the fees are re-valued at fetch time before the threshold is
 * compared. Re-valued, not re-read: the amounts came from chain earlier
 * in the same poll, so this costs a price lookup and no extra RPC.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Load the module with the price fetcher stubbed.
 *
 * Records whether the fresh-prices scope was open when the price was
 * read, which is the property under test.
 *
 * @param {object} prices  What the stubbed fetch answers.
 */
function loadWithProbe(prices) {
  const Module = require("module");
  const orig = Module.prototype.require;
  const probe = { fetches: 0, scopeOpenAtFetch: null };
  let scopeOpen = false;
  Module.prototype.require = function (id) {
    if (id !== "./price-fetcher") return orig.apply(this, arguments);
    const real = orig.apply(this, arguments);
    return {
      ...real,
      withFreshPricesAllowed: async (fn) => {
        scopeOpen = true;
        try {
          return await fn();
        } finally {
          scopeOpen = false;
        }
      },
      fetchTokenPrices: async () => {
        probe.fetches++;
        probe.scopeOpenAtFetch = scopeOpen;
        return prices;
      },
    };
  };
  try {
    delete require.cache[require.resolve("../src/bot-cycle-compound")];
    const mod = require("../src/bot-cycle-compound");
    /*- Evicted again so the stubbed copy is not handed to whoever
     *  requires this module next. */
    delete require.cache[require.resolve("../src/bot-cycle-compound")];
    return { mod, probe };
  } finally {
    Module.prototype.require = orig;
  }
}

/*- Ten of token0 and four of token1, valued by the poll at $7 total —
 *  a figure deliberately inconsistent with any price below, so a test
 *  that passes could only have re-valued. */
const deps = (over = {}) => ({
  position: { token0: "0xA", token1: "0xB" },
  _lastUnclaimedFeesUsd: 7,
  _lastUnclaimedFee0: 10,
  _lastUnclaimedFee1: 4,
  ...over,
});

describe("_freshFeesUsd()", () => {
  it("re-values the fees at freshly fetched prices", async () => {
    const { mod, probe } = loadWithProbe({ price0: 2, price1: 0.5 });
    const usd = await mod._freshFeesUsd(deps());
    assert.equal(usd, 10 * 2 + 4 * 0.5, "must recompute, not reuse the $7");
    assert.equal(probe.scopeOpenAtFetch, true, "the pause must be bypassed");
  });

  it("falls back when no amounts have been recorded yet", async () => {
    /*- Nothing has populated them — before the first poll completes, or
     *  for a caller that never valued fees. Nothing to re-value, so the
     *  poll's own figure stands. */
    for (const missing of [undefined, null]) {
      const { mod, probe } = loadWithProbe({ price0: 2, price1: 0.5 });
      const usd = await mod._freshFeesUsd(
        deps({ _lastUnclaimedFee0: missing }),
      );
      assert.equal(usd, 7);
      assert.equal(probe.fetches, 0, "nothing to value means nothing to fetch");
    }
  });

  it("falls back when the fresh fetch yields no price", async () => {
    /*- Compounding collects fees and re-deposits them on the same NFT —
     *  no range change, no new position. Delaying that indefinitely
     *  because a price source is down is worse than acting on the last
     *  known valuation. */
    const { mod } = loadWithProbe({ price0: 0, price1: 0.5 });
    assert.equal(await mod._freshFeesUsd(deps()), 7);
  });

  it("treats a genuinely zero fee amount as zero, not as missing", async () => {
    /*- A position that has earned nothing on one side is not a position
     *  whose fees are unknown; re-valuing must still happen. */
    const { mod } = loadWithProbe({ price0: 2, price1: 0.5 });
    const usd = await mod._freshFeesUsd(deps({ _lastUnclaimedFee1: 0 }));
    assert.equal(usd, 20);
  });
});

describe("checkCompound() — when the price is paid for", () => {
  /*- The fetch sits behind the gates that cost nothing, so a position
   *  that is not a compound candidate never pays for it. Without that
   *  ordering the lookup would run on every poll of every position,
   *  which is the traffic the idle pause exists to stop. */

  const base = {
    position: { token0: "0xA", token1: "0xB" },
    _lastUnclaimedFeesUsd: 7,
    _lastUnclaimedFee0: 10,
    _lastUnclaimedFee1: 4,
    _botState: {},
  };

  it("does not fetch when auto-compound is off", async () => {
    const { mod, probe } = loadWithProbe({ price0: 2, price1: 0.5 });
    const fired = await mod.checkCompound(
      { ...base, _getConfig: () => undefined },
      {},
      {},
      async () => {},
    );
    assert.equal(fired, false);
    assert.equal(probe.fetches, 0);
  });

  it("does not fetch while a scan is running", async () => {
    const { mod, probe } = loadWithProbe({ price0: 2, price1: 0.5 });
    const fired = await mod.checkCompound(
      {
        ...base,
        _botState: { _scanRunning: true },
        _getConfig: (k) => (k === "autoCompoundEnabled" ? true : undefined),
      },
      {},
      {},
      async () => {},
    );
    assert.equal(fired, false);
    assert.equal(probe.fetches, 0);
  });

  it("does not fetch inside the throttle window", async () => {
    const { mod, probe } = loadWithProbe({ price0: 2, price1: 0.5 });
    const fired = await mod.checkCompound(
      {
        ...base,
        _getConfig: (k) => {
          if (k === "autoCompoundEnabled") return true;
          if (k === "lastCompoundAt") return new Date().toISOString();
          return undefined;
        },
      },
      {},
      {},
      async () => {},
    );
    assert.equal(fired, false);
    assert.equal(probe.fetches, 0, "a throttled position must not pay");
  });

  it("fetches once when the position is a real candidate", async () => {
    /*- Every cheap gate passed, so the threshold comparison is the one
     *  decision left — and it is the one that must not run on a stale
     *  number. A high threshold keeps the compound from executing. */
    const { mod, probe } = loadWithProbe({ price0: 2, price1: 0.5 });
    const fired = await mod.checkCompound(
      {
        ...base,
        _getConfig: (k) => {
          if (k === "autoCompoundEnabled") return true;
          if (k === "autoCompoundThresholdUsd") return 1e9;
          return undefined;
        },
      },
      {},
      {},
      async () => {},
    );
    assert.equal(fired, false, "the threshold must still hold it back");
    assert.equal(probe.fetches, 1);
    assert.equal(probe.scopeOpenAtFetch, true);
  });
});

describe("checkCompound() — a forced compound", () => {
  /*- Manual "Compound Now" skips every threshold comparison, so nothing
   *  a fresh price could tell it would change the outcome. The compound
   *  it runs fetches fresh prices for the work itself. */

  const forcedDeps = () => ({
    position: { token0: "0xA", token1: "0xB" },
    _lastUnclaimedFeesUsd: 7,
    _lastUnclaimedFee0: 10,
    _lastUnclaimedFee1: 4,
    _botState: { forceCompound: true },
    _getConfig: () => undefined,
  });

  it("does not pay for a price it cannot act on", async () => {
    const { mod, probe } = loadWithProbe({ price0: 2, price1: 0.5 });
    /*- executeCompound is reached and fails on the empty stubs; the
     *  assertion is about what happened before it. */
    await mod
      .checkCompound(forcedDeps(), {}, {}, async () => {})
      .catch(() => {});
    assert.equal(probe.fetches, 0, "a forced compound decides nothing on it");
  });
});
