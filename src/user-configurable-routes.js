/**
 * @file src/user-configurable-routes.js
 * @module userConfigurableRoutes
 * @description
 * Bundles the HTTP route handlers that serve JSON payloads from the
 * layered defaults+user-override loader (shipped defaults in
 * `app-config/app-defaults-for-user-configurable/` merged with the
 * matching files under `app-config/user-configurable/`) so each
 * individual tunable module (ui-defaults, lp-providers, etc.) does
 * not need its own dedicated require + route-table entry in
 * `server.js`.  Keeps the server route table compact while preserving
 * the per-module isolation of read/parse logic and fallbacks.
 */

"use strict";

const { handleUiDefaults } = require("./ui-defaults");
const { handleLpProviders } = require("./lp-providers");
const { handleBotConfigDefaults } = require("./bot-config-defaults");
const { handleChartProviders } = require("./chart-providers");
const { handleSettingLabels } = require("./setting-labels");

/**
 * Build the `{ "METHOD /path": handler }` route map for all
 * user-configurable endpoints.  Each handler is already wrapped with
 * the caller-supplied `jsonResponse` helper.
 * @param {Function} jsonResponse  `(res, status, body) => void`
 * @returns {Record<string, (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void>}
 */
function userConfigurableRoutes(jsonResponse) {
  return {
    "GET /api/ui-defaults": (req, res) =>
      handleUiDefaults(req, res, jsonResponse),
    "GET /api/lp-providers": (req, res) =>
      handleLpProviders(req, res, jsonResponse),
    "GET /api/bot-config-defaults": (req, res) =>
      handleBotConfigDefaults(req, res, jsonResponse),
    "GET /api/chart-providers": (req, res) =>
      handleChartProviders(req, res, jsonResponse),
    "GET /api/setting-labels": (req, res) =>
      handleSettingLabels(req, res, jsonResponse),
  };
}

module.exports = { userConfigurableRoutes };
