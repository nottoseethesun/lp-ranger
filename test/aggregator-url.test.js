/**
 * @file test/aggregator-url.test.js
 * @description Locks the shape of the 9mm DEX Aggregator REST URL.
 *
 * Why this file exists: the aggregator quote URL shipped without its
 * chain slug segment on 2026-03-31 and stayed that way. The live API
 * answers the slug-less path with a 404 — verified directly:
 *
 *   404  https://api.9mm.pro/swap/v1/quote?…
 *   200  https://api.9mm.pro/pulsechain/swap/v1/quote?…
 *
 * Nothing caught it for months. The existing aggregator tests all stub
 * `fetch`, so they assert how the code handles a *response* and never
 * look at the URL; and in production a failed aggregator quote falls
 * through to the V3 SwapRouter, so swaps still completed — just on the
 * worse route, silently.
 *
 * These tests therefore assert the URL itself, built from the shipped
 * config, with no network and no `fetch` stub in the assertion path.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");

const { _aggregatorBase } = require("../src/rebalancer-aggregator");
const config = require("../src/config");
const CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");

describe("aggregator base URL", () => {
  it("includes the chain slug segment", () => {
    const base = _aggregatorBase();
    assert.strictEqual(base, `${config.AGGREGATOR_URL}/pulsechain`);
  });

  it("produces the exact path the 9mm API answers with 200", () => {
    /*- The slug-less form 404s. Asserting the full path, not just a
     *  substring, so dropping the segment fails here rather than in
     *  production. */
    assert.strictEqual(
      `${_aggregatorBase()}/swap/v1/quote`,
      "https://api.9mm.pro/pulsechain/swap/v1/quote",
    );
  });

  it("never yields the 404-ing slug-less path", () => {
    assert.notStrictEqual(
      `${_aggregatorBase()}/swap/v1/quote`,
      "https://api.9mm.pro/swap/v1/quote",
    );
  });

  it("does not double up slashes", () => {
    const base = _aggregatorBase();
    assert.ok(!base.replace("https://", "").includes("//"), base);
  });
});

describe("aggregator slug config", () => {
  it("every chain declares an aggregator.blockchain key", () => {
    /*- Presence is required even when blank, so adding a chain forces
     *  an explicit decision instead of silently inheriting a 404. */
    for (const [name, chain] of Object.entries(CHAINS)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(chain.aggregator, "blockchain"),
        `${name}.aggregator is missing the blockchain key`,
      );
      assert.strictEqual(
        typeof chain.aggregator.blockchain,
        "string",
        `${name}.aggregator.blockchain must be a string`,
      );
    }
  });

  it("pulsechain carries the verified slug", () => {
    assert.strictEqual(CHAINS.pulsechain.aggregator.blockchain, "pulsechain");
  });

  it("keeps the slug distinct from the chart-provider slugs", () => {
    /*- Same chain, three independently-configured vendor slugs. Two
     *  now coincide on "pulsechain" and DexTools still says "pulse" —
     *  which is exactly why they stay separate keys: coinciding values
     *  are a coincidence, not a shared setting. */
    const chain = CHAINS.pulsechain;
    assert.strictEqual(chain.aggregator.blockchain, "pulsechain");
    assert.strictEqual(chain.chartProviders.dextools.blockchain, "pulse");
    assert.strictEqual(chain.dexPairDetailPageUrl.blockchain, "pulsechain");
  });
});
