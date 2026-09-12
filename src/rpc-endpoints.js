/**
 * @file src/rpc-endpoints.js
 * @module rpcEndpoints
 * @description
 * Serves the active chain's RPC endpoint list to the dashboard, so the
 * RPC URL control's preset menu is built from configuration instead of
 * being written into the markup.
 *
 * **Why this exists at all.**  `public/index.html` used to carry the
 * presets as three hardcoded `<li data-rpc="…">` entries.  That is
 * config data living in the presentation layer, which the project
 * forbids for a concrete reason: markup becomes a silent second source
 * of truth.  The hardcoded list had already drifted — it offered an
 * endpoint that appears nowhere else in the repo and is not part of the
 * failover chain, so the menu advertised something the bot would never
 * actually use.
 *
 * Serving the same list the failover walks means the menu cannot
 * disagree with the bot, and adding a fourth endpoint is a one-line
 * change in `chains.json` with no HTML edit.
 *
 * Mirrors `src/chart-providers.js`, which solves the same problem for
 * the chart links.
 */

"use strict";

const config = require("./config");

/**
 * Shape one endpoint for display.
 *
 * The label is the bare host — the scheme is noise in a menu, and the
 * ordinal ("primary", "2nd choice") tells the operator what the bot
 * will actually do with it, which the raw URL does not.
 * @param {string} url    Full endpoint URL.
 * @param {number} index  Position in the ordered failover list.
 * @returns {{url: string, host: string, label: string, primary: boolean}}
 */
function _describe(url, index) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /*- Not parseable as a URL: show it verbatim rather than hiding an
     *  endpoint an operator deliberately configured. */
  }
  return {
    url,
    host,
    label: index === 0 ? `${host} (primary)` : `${host} (fallback ${index})`,
    primary: index === 0,
  };
}

/**
 * The active chain's endpoints, in failover order.
 * @returns {Array<{url: string, host: string, label: string, primary: boolean}>}
 */
function readRpcEndpoints() {
  return (config.RPC_URLS || []).map(_describe);
}

/**
 * Route handler for `GET /api/rpc-endpoints`.  Always 200 with an
 * `{ endpoints: [...] }` shape.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleRpcEndpoints(_req, res, jsonResponse) {
  jsonResponse(res, 200, { endpoints: readRpcEndpoints() });
}

module.exports = { readRpcEndpoints, handleRpcEndpoints, _describe };
