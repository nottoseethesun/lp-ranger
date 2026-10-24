/**
 * @file test/aggregator-url.test.js
 * @description Locks the shape of the aggregator quote URL, built from the
 * shipped config.
 *
 * A wrong URL fails silently everywhere else. The quote request fails,
 * the swap falls through to the V3 SwapRouter and completes on the worse
 * route, and nothing reports it. The other aggregator tests stub `fetch`,
 * so they see only how the code handles a *response*, never the URL it
 * asked. These tests therefore assert the URL itself, with no network and
 * no `fetch` stub in the assertion path.
 *
 * Each chain names its whole aggregator base in chains.json, chain path
 * included, because the vendor chooses that path: Watergun keys it by
 * chain id.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");

const { _aggregatorBase } = require("../src/lib/rebalancer-aggregator");
const { primaryRouteLabel } = require("../src/lib/rebalancer-swap");
const { V3_ROUTER_LABEL } = require("../src/lib/rebalancer-router");
const { resolvedHelpFigures } = require("../src/lib/resolved-settings");
const {
  aggregatorBaseUrlOf,
  aggregatorNameInUse,
} = require("../src/lib/aggregator-in-use");
const config = require("../src/lib/config");
const CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");

describe("aggregator base URL", () => {
  it("is the active chain's url, unchanged", () => {
    assert.strictEqual(
      _aggregatorBase(),
      CHAINS[config.CHAIN_NAME].aggregator.url,
    );
  });

  it("produces the exact PulseChain quote path, chain id included", () => {
    /*-
     *  Asserting the full path, not a substring, so a dropped chain
     *  segment fails here rather than in production.
     */
    assert.strictEqual(
      `${_aggregatorBase()}/swap/v1/quote`,
      "https://swap.watergun.pro/api/aggregator/369/swap/v1/quote",
    );
  });

  it("does not double up slashes, even under a trailing slash", () => {
    const saved = config.AGGREGATOR_URL;
    config.AGGREGATOR_URL = `${saved}/`;
    try {
      const base = _aggregatorBase();
      assert.ok(!base.replace("https://", "").includes("//"), base);
      assert.strictEqual(base, saved);
    } finally {
      config.AGGREGATOR_URL = saved;
    }
  });

  it("throws on a chain with no aggregator, naming the setting", () => {
    /*-
     *  The throw is how a chain without an aggregator reaches the V3
     *  router: `swapIfNeeded` treats it as a failed quote.
     */
    const saved = config.AGGREGATOR_URL;
    config.AGGREGATOR_URL = "";
    try {
      assert.throws(() => _aggregatorBase(), /aggregator\.url/);
    } finally {
      config.AGGREGATOR_URL = saved;
    }
  });

  it("reads a url of slashes alone as no aggregator, for the swap, the badge and the help alike", () => {
    /*-
     *  The "Route:" badge, the help and the swap ask one
     *  question, so neither the badge nor the help can name the
     *  aggregator while every swap goes through the V3 router. A url
     *  that is not a string never gets here: src/lib/config.js refuses to
     *  start on one (test/config-startup-checks.test.js).
     */
    const saved = config.AGGREGATOR_URL;
    config.AGGREGATOR_URL = "/";
    try {
      assert.throws(() => _aggregatorBase(), /aggregator\.url/);
      assert.strictEqual(primaryRouteLabel(), V3_ROUTER_LABEL);
      assert.strictEqual(resolvedHelpFigures().aggregatorName, "");
      assert.strictEqual(resolvedHelpFigures().aggregatorInUse, "none");
    } finally {
      config.AGGREGATOR_URL = saved;
    }
  });

  it("lets the help name the aggregator the swap tries first", () => {
    assert.strictEqual(
      resolvedHelpFigures().aggregatorName,
      config.AGGREGATOR_NAME,
    );
  });
});

describe("whether a chain has an aggregator", () => {
  it("is its url's base, without trailing slashes", () => {
    assert.strictEqual(
      aggregatorBaseUrlOf("https://a.example/x/"),
      "https://a.example/x",
    );
    assert.strictEqual(aggregatorBaseUrlOf("/"), "");
    assert.strictEqual(aggregatorBaseUrlOf(""), "");
  });

  it("decides whether its name is the one in use", () => {
    assert.strictEqual(aggregatorNameInUse("https://a.example", "A"), "A");
    assert.strictEqual(aggregatorNameInUse("//", "A"), "");
    assert.strictEqual(aggregatorNameInUse("", ""), "");
  });
});

describe("aggregator url config", () => {
  it("every chain declares an aggregator.url string", () => {
    /*-
     *  Presence is required even when blank, so adding a chain forces an
     *  explicit decision about its aggregator instead of a silent gap.
     */
    for (const [name, chain] of Object.entries(CHAINS)) {
      assert.strictEqual(
        typeof chain.aggregator?.url,
        "string",
        `${name}.aggregator.url must be a string`,
      );
    }
  });

  it("every chain names both swap routes, even when blank", () => {
    /*-
     *  The names are what the badge and the Rebalance Events table show,
     *  and src/lib/config.js supplies none of its own.
     */
    for (const [name, chain] of Object.entries(CHAINS)) {
      assert.strictEqual(
        typeof chain.aggregator?.name,
        "string",
        `${name}.aggregator.name must be a string`,
      );
      assert.strictEqual(
        typeof chain.contracts?.swapRouter?.name,
        "string",
        `${name}.contracts.swapRouter.name must be a string`,
      );
    }
  });

  it("PulseChain names the Watergun Aggregator", () => {
    assert.strictEqual(
      CHAINS.pulsechain.aggregator.url,
      "https://swap.watergun.pro/api/aggregator/369",
    );
  });

  it("the testnet names none, because Watergun does not serve it", () => {
    /*-
     *  Watergun answers chain 943 with "not served by this gateway", so
     *  every testnet swap goes through the V3 router.
     */
    assert.strictEqual(CHAINS["pulsechain-testnet"].aggregator.url, "");
  });

  it("no chain still carries the retired slug or api key", () => {
    for (const [name, chain] of Object.entries(CHAINS)) {
      assert.ok(!("blockchain" in chain.aggregator), `${name}: blockchain`);
      assert.ok(!("apiKey" in chain.aggregator), `${name}: apiKey`);
    }
  });
});
