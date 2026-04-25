/**
 * @file src/static-tunables-routes.js
 * @module staticTunablesRoutes
 * @description
 * Bundles the HTTP route handlers that serve JSON payloads from
 * `app-config/static-tunables/` so each individual tunable module
 * (ui-defaults, nft-providers, etc.) does not need its own dedicated
 * require + route-table entry in `server.js`.  Keeps the server
 * route table compact while preserving the per-module isolation of
 * read/parse logic and fallbacks.
 */

"use strict";

const { handleUiDefaults } = require("./ui-defaults");
const { handleNftProviders } = require("./nft-providers");
const { handleBotConfigDefaults } = require("./bot-config-defaults");

/**
 * Build the `{ "METHOD /path": handler }` route map for all static-
 * tunables endpoints.  Each handler is already wrapped with the
 * caller-supplied `jsonResponse` helper.
 * @param {Function} jsonResponse  `(res, status, body) => void`
 * @returns {Record<string, (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void>}
 */
function staticTunablesRoutes(jsonResponse) {
  return {
    "GET /api/ui-defaults": (req, res) =>
      handleUiDefaults(req, res, jsonResponse),
    "GET /api/nft-providers": (req, res) =>
      handleNftProviders(req, res, jsonResponse),
    "GET /api/bot-config-defaults": (req, res) =>
      handleBotConfigDefaults(req, res, jsonResponse),
  };
}

module.exports = { staticTunablesRoutes };
