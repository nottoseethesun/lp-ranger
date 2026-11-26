/**
 * @file src/server/user-configurable-routes.js
 * @module userConfigurableRoutes
 * @description
 * Bundles the HTTP route handlers that serve the install's settings as
 * JSON, so each individual tunable module (ui-defaults, lp-providers,
 * etc.) does not need its own dedicated require + route-table entry in
 * `server.js`.  Four read their data through the layered
 * defaults+user-override loader (shipped defaults in
 * `app-config/app-defaults-for-user-configurable/` merged with the
 * matching files under `app-config/user-configurable/`):
 * `GET /api/ui-defaults`, `GET /api/lp-providers`,
 * `GET /api/chart-providers` and `GET /api/setting-labels`.  The others
 * put more on top: `GET /api/bot-config-defaults` and
 * `GET /api/help-figures` take `.env` for the settings it can set
 * (src/server/resolved-settings.js); `GET /api/rpc-endpoints` lists
 * `config.RPC_URLS`, the operator's saved urls and `.env`'s ahead of
 * chains.json's (src/server/rpc-endpoints.js); and `GET /api/chain`
 * reports the chain itself, which `CHAIN_NAME` in `.env` picks.  Keeps
 * the server route table compact while preserving the per-module
 * isolation of read/parse logic and fallbacks.
 */

"use strict";

const { readUiDefaults } = require("../lib/ui-defaults");
const {
  readLpProvidersWithDexDetailPages,
} = require("./dex-detail-page-url-generator");
const {
  handleBotConfigDefaults,
  handleHelpFigures,
} = require("./resolved-settings");
const { handleChartProviders } = require("./chart-providers");
const { handleRpcEndpoints } = require("./rpc-endpoints");
const { readSettingLabels } = require("../lib/setting-labels");
const config = require("../lib/config");

/**
 * Route handler for `GET /api/ui-defaults`: the dashboard settings in
 * force (src/lib/ui-defaults.js). Always 200.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleUiDefaults(_req, res, jsonResponse) {
  jsonResponse(res, 200, readUiDefaults());
}

/**
 * Route handler for `GET /api/lp-providers`: the LP providers, each with
 * its DEX detail page for the active chain when it configures one
 * (`readLpProvidersWithDexDetailPages`,
 * src/server/dex-detail-page-url-generator.js). Always
 * 200 with a well-formed map, possibly empty.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleLpProviders(_req, res, jsonResponse) {
  jsonResponse(res, 200, readLpProvidersWithDexDetailPages());
}

/**
 * Route handler for `GET /api/setting-labels`. Always returns 200 with a
 * well-formed map (possibly empty); parse failures surface via the
 * empty-map path inside `readSettingLabels()` (src/lib/setting-labels.js).
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleSettingLabels(_req, res, jsonResponse) {
  jsonResponse(res, 200, readSettingLabels());
}

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
    "GET /api/help-figures": (req, res) =>
      handleHelpFigures(req, res, jsonResponse),
    "GET /api/chart-providers": (req, res) =>
      handleChartProviders(req, res, jsonResponse),
    "GET /api/rpc-endpoints": (req, res) =>
      handleRpcEndpoints(req, res, jsonResponse),
    "GET /api/setting-labels": (req, res) =>
      handleSettingLabels(req, res, jsonResponse),
    /*-
     *  The active chain — which `chains.json` entry this process runs
     *  against. The dashboard reads it once, before it builds any
     *  position key or url: the chain is the first segment of both, and
     *  a dashboard that assumed "pulsechain" would file a testnet
     *  position's settings under a mainnet key. The display name,
     *  homepage and logo make the header's chain link, and the token
     *  list's url is where the dashboard reads token logos ("" for a
     *  chain with none). `src/lib/config.js` refuses to start without any of
     *  them, so none needs a fallback here.
     */
    "GET /api/chain": (_req, res) =>
      jsonResponse(res, 200, {
        chainId: config.CHAIN_NAME,
        displayName: config.CHAIN.displayName,
        homepage: config.CHAIN.homepage,
        logo: config.CHAIN.logo,
        tokenListUrl: config.TOKEN_LIST_URL,
      }),
  };
}

module.exports = {
  userConfigurableRoutes,
  handleUiDefaults,
  handleLpProviders,
  handleSettingLabels,
};
