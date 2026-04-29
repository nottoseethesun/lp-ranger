/**
 * @file src/chart-providers.js
 * @module chartProviders
 * @description
 * Backs `GET /api/chart-providers`, which feeds the Chart Links section
 * of the Pool Details modal. All provider data — display name, host,
 * the per-chain blockchain slug (e.g. "pulse" for DexTools but
 * "pulsechain" for DexScreener / GeckoTerminal), and the URL path
 * segments — lives in `app-config/static-tunables/chains.json` under
 * each chain's `chartProviders` key. Nothing chain-specific is hard
 * coded in JS.
 *
 * Each provider entry has shape:
 *   {
 *     name:         string        // "DexScreener"
 *     scheme:       string        // "https" (always, for now)
 *     domain:       string        // "dexscreener.com"
 *     blockchain:   string        // "pulsechain" or "pulse" — slug used in path
 *     pathSegments: string[]      // ["{blockchain}", "pools", "{poolId}"]
 *   }
 *
 * The handler joins scheme + domain + path segments into a URL
 * template with `{blockchain}` already substituted server-side; the
 * client only needs to replace `{poolId}` (the lowercased pool
 * address).
 */

"use strict";

const CHAINS = require("../app-config/static-tunables/chains.json");
const { CHAIN_NAME } = require("./runtime-flags");

/**
 * Build a URL template by joining the scheme, domain and path
 * segments, and substituting the per-chain blockchain slug into any
 * `{blockchain}` placeholders. The result still contains the
 * `{poolId}` placeholder so the client can drop in the lowercased
 * pool address.
 * @param {{ scheme: string, domain: string, blockchain: string, pathSegments: string[] }} entry
 * @returns {string|null}  null when the entry is malformed.
 */
function _buildUrlTemplate(entry) {
  if (!entry || typeof entry.scheme !== "string" || !entry.scheme) return null;
  if (typeof entry.domain !== "string" || !entry.domain) return null;
  if (typeof entry.blockchain !== "string" || !entry.blockchain) return null;
  if (!Array.isArray(entry.pathSegments)) return null;
  const segments = entry.pathSegments.map((s) =>
    typeof s === "string" ? s.replace("{blockchain}", entry.blockchain) : "",
  );
  return `${entry.scheme}://${entry.domain}/${segments.join("/")}`;
}

/**
 * Pure helper: turn a `chartProviders` object (as it lives under each
 * chain in chains.json) into the wire shape returned by the route.
 * Malformed entries are dropped so the UI never renders a broken
 * link. Exposed so tests can exercise edge cases without writing to
 * the on-disk chains.json (which would race other tests).
 * @param {Record<string, object> | null | undefined} providersObj
 * @returns {Array<{ key: string, name: string, urlTemplate: string }>}
 */
function _buildProvidersList(providersObj) {
  const out = [];
  for (const [key, entry] of Object.entries(providersObj || {})) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    const urlTemplate = _buildUrlTemplate(entry);
    if (!urlTemplate || !urlTemplate.includes("{poolId}")) continue;
    out.push({ key, name: entry.name, urlTemplate });
  }
  return out;
}

/**
 * Resolve the chart-provider list for the given chain. Each returned
 * entry has its scheme, domain, and `{blockchain}` slug already
 * substituted; the client just replaces `{poolId}`.
 * @param {string} chainName  Active chain key (e.g. "pulsechain").
 * @returns {Array<{ key: string, name: string, urlTemplate: string }>}
 */
function readChartProviders(chainName) {
  const chain = CHAINS[chainName] || CHAINS.pulsechain;
  return _buildProvidersList(chain && chain.chartProviders);
}

/**
 * Route handler for `GET /api/chart-providers`. Always returns 200 with
 * a `{ providers: [...] }` shape — empty array when no providers are
 * configured for the active chain.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleChartProviders(_req, res, jsonResponse) {
  jsonResponse(res, 200, { providers: readChartProviders(CHAIN_NAME) });
}

module.exports = {
  readChartProviders,
  handleChartProviders,
  _buildProvidersList,
};
