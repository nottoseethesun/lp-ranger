/**
 * @file src/nft-providers.js
 * @module nftProviders
 * @description
 * Reads `nft-providers.json` (via the layered defaults+user-override
 * loader — see `src/load-merged-defaults.js`) and exposes the labels
 * to the dashboard via `GET /api/nft-providers`. The mapping lets the
 * NFT panel display a short "liquidity-pool provider" label (e.g.
 * "9mm v3") next to Fee Tier, keyed by the NFT position-manager
 * contract address.
 *
 * The file is re-read on every request so operators can edit
 * `app-config/user-configurable/nft-providers.json` live without a
 * server restart.  Read or parse failures fall back to an empty map so
 * the endpoint never 500s.
 */

"use strict";

const { log } = require("./log");
const { loadMergedDefaults } = require("./load-merged-defaults");

const _FILENAME = "nft-providers.json";

/**
 * Read and parse the NFT-providers JSON, stripping the `_comment` key
 * and lower-casing all address keys so callers can look up by either
 * checksum or lowercase.  On any error returns an empty object so
 * callers can treat the result as always-valid.
 * @returns {Record<string, string>}
 */
function readNftProviders() {
  try {
    const parsed = loadMergedDefaults(_FILENAME);
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "string") continue;
      const label = v.trim();
      if (!label) continue;
      out[k.toLowerCase()] = label;
    }
    return out;
  } catch (err) {
    log.warn("[nft-providers] Falling back to empty map: %s", err.message);
    return {};
  }
}

/**
 * Route handler for `GET /api/nft-providers`. Always returns 200 with a
 * well-formed map (possibly empty); parse failures surface via the
 * empty-map path inside `readNftProviders()`.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleNftProviders(_req, res, jsonResponse) {
  jsonResponse(res, 200, readNftProviders());
}

module.exports = { readNftProviders, handleNftProviders };
