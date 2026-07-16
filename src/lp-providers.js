/**
 * @file src/lp-providers.js
 * @module lpProviders
 * @description
 * Reads `lp-providers.json` (via the layered defaults + user-override
 * loader — see `src/load-merged-defaults.js`) and exposes metadata for
 * LP position providers, keyed by the composite pair
 * `<poolFactoryAddress>_<positionManagerAddress>` in EIP-55 checksum
 * casing.  The composite key lets a single wallet hold LPs from
 * multiple v3-fork DEXes without ambiguity.
 *
 * Each entry is an object:
 * ```
 * {
 *   displayName: "9mm v3",
 *   supportedBlockchainsByLpRangerAndLpProvider: ["pulsechain"]
 * }
 * ```
 * `displayName` is the short label shown to users (locale-dependent,
 * never a lookup key).  The blockchain list uses canonical chain IDs
 * — the KEY of `chains.json` entries (e.g. `"pulsechain"`), not the
 * `displayName` — because IDs are stable lookup keys and displayNames
 * can vary by locale.  This list restricts a match to the chains
 * we've verified for that deployment (the same factory + PM hash may
 * exist on multiple v3-fork clones).
 *
 * The file is re-read on every request so operators can edit
 * `app-config/user-configurable/lp-providers.json` live without a
 * server restart.  Read or parse failures fall back to an empty map so
 * the endpoint never 500s.
 *
 * Case handling: JSON keys are stored in canonical EIP-55 casing and
 * are NOT normalised on load.  `getLpProvider` and
 * `getLpProviderDisplayName` canonicalise the incoming factory +
 * positionManager via `ethers.getAddress` before composing the lookup
 * key — so callers can pass any casing (raw keyboard input from the
 * LP browser paste field, URL segments, etc.) and the lookup still
 * matches.  Invalid addresses (checksum failure, wrong length) return
 * `undefined` so garbage input surfaces as a missing entry rather
 * than a silent partial match.
 */

"use strict";

const { ethers } = require("ethers");
const { log } = require("./log");
const { loadMergedDefaults } = require("./load-merged-defaults");

const _FILENAME = "lp-providers.json";

/**
 * Compose the JSON lookup key by EIP-55 checksumming each half.
 * Returns `null` when either address fails validation.
 * @param {string} factory
 * @param {string} positionManager
 * @returns {string | null}
 */
function _compositeKey(factory, positionManager) {
  try {
    return `${ethers.getAddress(factory)}_${ethers.getAddress(positionManager)}`;
  } catch {
    return null;
  }
}

/**
 * Read and parse the LP-providers JSON.  Skips the `_comment` key,
 * skips entries without a valid `displayName` string, trims the
 * displayName, and normalises `supportedBlockchainsByLpRangerAndLpProvider`
 * to a filtered string array (missing / non-array / null → empty
 * array, so chain-gating callers fail closed on malformed entries
 * rather than crashing on `.includes()`).  On any error returns an
 * empty object so callers can treat the result as always-valid.
 * @returns {Record<string, {displayName:string, supportedBlockchainsByLpRangerAndLpProvider:string[]}>}
 */
function readLpProviders() {
  try {
    const parsed = loadMergedDefaults(_FILENAME);
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k === "_comment") continue;
      if (!v || typeof v !== "object") continue;
      if (typeof v.displayName !== "string") continue;
      const displayName = v.displayName.trim();
      if (!displayName) continue;
      const chains = Array.isArray(
        v.supportedBlockchainsByLpRangerAndLpProvider,
      )
        ? v.supportedBlockchainsByLpRangerAndLpProvider.filter(
            (c) => typeof c === "string" && c.trim(),
          )
        : [];
      out[k] = {
        ...v,
        displayName,
        supportedBlockchainsByLpRangerAndLpProvider: chains,
      };
    }
    return out;
  } catch (err) {
    log.warn("[lp-providers] Falling back to empty map: %s", err.message);
    return {};
  }
}

/*- Dedup set: canonical composite keys we've already logged as
 *  "no entry found".  Warning fires once per unique missing pair
 *  rather than every poll cycle — surfaces a stale
 *  lp-providers.json entry or the appearance of a new v3-fork DEX we
 *  haven't added an entry for.  Missing factory / positionManager
 *  (falsy) and invalid EIP-55 addresses (composite key null) never
 *  reach here — those are caller-input problems, not lookup misses. */
const _loggedMissingProviders = new Set();

/**
 * Lookup the full LP-provider entry for a (factory, positionManager)
 * pair.  Returns `undefined` when the pair is unknown OR either
 * address fails EIP-55 validation.  Callers that also care about
 * blockchain support should check the returned entry's
 * `supportedBlockchainsByLpRangerAndLpProvider` array against the
 * current chain's canonical ID — the KEY of `chains.json` (e.g.
 * `"pulsechain"`), not its `displayName`.
 *
 * When both addresses are syntactically valid but the pair has no
 * entry in the map, emits a dedup'd `log.warn` so a missing entry
 * surfaces once per server run without spamming the poll loop.
 * @param {string|null|undefined} factory
 * @param {string|null|undefined} positionManager
 * @returns {{displayName:string, supportedBlockchainsByLpRangerAndLpProvider:string[]} | undefined}
 */
function getLpProvider(factory, positionManager) {
  if (!factory || !positionManager) return undefined;
  const key = _compositeKey(factory, positionManager);
  if (!key) return undefined;
  const entry = readLpProviders()[key];
  if (!entry && !_loggedMissingProviders.has(key)) {
    _loggedMissingProviders.add(key);
    log.warn(
      "[lp-providers] no entry for factory+positionManager pair %s — position will render without a provider label",
      key,
    );
  }
  return entry;
}

/**
 * Convenience wrapper: return only the short display label for a
 * (factory, positionManager) pair.  Returns `undefined` when the pair
 * is unknown OR either address fails EIP-55 validation.
 * @param {string|null|undefined} factory
 * @param {string|null|undefined} positionManager
 * @returns {string | undefined}
 */
function getLpProviderDisplayName(factory, positionManager) {
  return getLpProvider(factory, positionManager)?.displayName;
}

/*- Dedup set: `${canonicalKey}::${chainId}` triples we've already
 *  logged as unsupported.  Warning fires once per unique mismatch
 *  rather than every poll cycle — enough to surface a stale
 *  lp-providers.json entry or an unexpected fork-clone deployment
 *  without spamming the log. */
const _loggedUnsupportedChains = new Set();

/**
 * Check whether an LP-provider entry (found via `getLpProvider`) has
 * the given canonical chain id in its
 * `supportedBlockchainsByLpRangerAndLpProvider` list.  Returns `false`
 * for an unknown (factory, positionManager) pair, an invalid chainId,
 * or a valid entry whose list doesn't include the chain.
 *
 * When the entry exists but the chain is NOT supported, emits a
 * warning via `log.warn` with the composite key + displayName +
 * missing chainId + the list we actually have on file.  Dedup'd so
 * the warning fires once per unique triple, not per poll cycle.
 * @param {string|null|undefined} factory
 * @param {string|null|undefined} positionManager
 * @param {string} chainId  Canonical chain id — the KEY of chains.json (e.g. "pulsechain").
 * @returns {boolean}
 */
function isChainSupported(factory, positionManager, chainId) {
  const entry = getLpProvider(factory, positionManager);
  if (!entry) return false;
  if (!chainId || typeof chainId !== "string") return false;
  const supported = entry.supportedBlockchainsByLpRangerAndLpProvider;
  if (supported.includes(chainId)) return true;
  const canonicalKey = _compositeKey(factory, positionManager);
  const dedupKey = `${canonicalKey}::${chainId}`;
  if (!_loggedUnsupportedChains.has(dedupKey)) {
    _loggedUnsupportedChains.add(dedupKey);
    log.warn(
      "[lp-providers] chain %j not in supportedBlockchainsByLpRangerAndLpProvider for %s (%s): supported=%j",
      chainId,
      entry.displayName,
      canonicalKey,
      supported,
    );
  }
  return false;
}

/**
 * Route handler for `GET /api/lp-providers`.  Serves the raw map with
 * keys in canonical EIP-55 casing and object values (displayName +
 * supportedBlockchainsByLpRangerAndLpProvider).  Always returns 200
 * with a well-formed map (possibly empty); parse failures surface via
 * the empty-map path inside `readLpProviders()`.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleLpProviders(_req, res, jsonResponse) {
  jsonResponse(res, 200, readLpProviders());
}

module.exports = {
  readLpProviders,
  getLpProvider,
  getLpProviderDisplayName,
  isChainSupported,
  handleLpProviders,
};
