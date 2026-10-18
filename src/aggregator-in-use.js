"use strict";

/**
 * @file src/aggregator-in-use.js
 * @module aggregator-in-use
 * @description
 * Whether a chain has a swap aggregator, and what it is called when it
 * does.
 *
 * A chain's entry in chains.json gives its aggregator a url and a name.
 * An empty url means the chain has none, and every swap goes through the
 * V3 router. The test is made on the url's base, the url without trailing
 * slashes, so a url of "/" alone is no aggregator either.
 *
 * Three things act on this answer and must agree: the swap, which tries
 * the aggregator first (`src/rebalancer-aggregator.js`); the "Routing
 * through:" badge, which must not name a route the swap does not try; and
 * the help, which names the aggregator in use. So the rule is written
 * once, here.
 *
 * **Dependency-free**, so the User Manual's build, which reads only the
 * shipped files, applies the rule without loading the app's configuration.
 */

/**
 * The base of an aggregator url: the url without trailing slashes.
 * @param {string} url  A chain's `aggregator.url`, or `.env`'s.
 * @returns {string} "" when the chain has no aggregator.
 */
function aggregatorBaseUrlOf(url) {
  return url.replace(/\/+$/, "");
}

/**
 * The name of a chain's aggregator, or "" when it has none.
 * @param {string} url   The chain's aggregator url.
 * @param {string} name  The chain's aggregator name.
 * @returns {string}
 */
function aggregatorNameInUse(url, name) {
  return aggregatorBaseUrlOf(url).length > 0 ? name : "";
}

module.exports = { aggregatorBaseUrlOf, aggregatorNameInUse };
