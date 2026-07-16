/**
 * @file dashboard-lp-providers.js
 * @description Client mirror of `src/lp-providers.js`.  Fetches the
 *   LP-provider metadata map from `GET /api/lp-providers` (backed by
 *   `app-config/app-defaults-for-user-configurable/lp-providers.json`),
 *   canonicalises addresses via `ethers.getAddress`, and exposes label
 *   + entry lookups keyed by the composite pair
 *   `<poolFactoryAddress>_<positionManagerAddress>`.
 *
 *   Missing-entry and unsupported-chain paths emit dedup'd
 *   `console.warn` messages (mirror of the server-side `log.warn`
 *   behavior) so the same class of misconfiguration surfaces once no
 *   matter which side hits it first.
 *
 *   Factory context: legacy call sites (NFT-panel label paint) took a
 *   single `contractAddress` because there was only one lookup key.
 *   The composite scheme needs `factory` too, but factory is a
 *   session-wide server constant, so `setFactoryContext(factory)` is
 *   called once when the first `/api/status` poll arrives and the
 *   cached value backs the legacy single-arg helpers
 *   (`getProviderLabel` / `setProviderLabelFor`).  New call sites (the
 *   All Positions Stats modal) should use the explicit two-arg
 *   `getProvider` / `getProviderDisplayName` helpers.
 */

import { log } from "./dashboard-log.js";
import { g } from "./dashboard-helpers.js";
import { ethers } from "./ethers-adapter.js";

/**
 * In-memory cache populated once at init.  Keys are the raw JSON keys
 * from the server (canonical EIP-55 composite), values are entry
 * objects `{ displayName, supportedBlockchainsByLpRangerAndLpProvider }`.
 */
let _providerMap = {};

/**
 * Sticky pool-factory address for the running server.  Populated by
 * `setFactoryContext` after the first `/api/status` poll.  Legacy
 * single-arg helpers pair this with the passed positionManager to
 * compose the composite lookup key.
 */
let _factory = null;

/*- Dedup sets: mirror of the server-side `_loggedMissingProviders` /
 *  `_loggedUnsupportedChains` behavior.  Warnings fire once per
 *  unique (composite-key) / (composite-key,chainId) triple, not per
 *  poll cycle. */
const _loggedMissingProviders = new Set();
const _loggedUnsupportedChains = new Set();

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
 * One-shot fetch of the provider map.  Fetch or parse errors leave
 * the cache empty so the provider label simply stays hidden — never
 * blocks the dashboard from rendering.
 * @returns {Promise<void>}
 */
export async function loadLpProviders() {
  try {
    const res = await fetch("/api/lp-providers");
    if (!res.ok) return;
    const data = await res.json();
    _providerMap =
      data !== null && data !== undefined && typeof data === "object"
        ? data
        : {};
    log.info(
      "[lp-providers] loaded %d mapping(s)",
      Object.keys(_providerMap).length,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    log.warn("[lp-providers] fetch failed:", msg);
  }
}

/**
 * Cache the running server's pool-factory address.  Called from
 * `dashboard-data.js` after each `/api/status` poll; the sticky value
 * lets legacy single-arg helpers reconstruct the composite key.
 * @param {string|null|undefined} factory
 */
export function setFactoryContext(factory) {
  if (typeof factory === "string" && factory.length > 0) _factory = factory;
}

/**
 * Lookup the full LP-provider entry for a (factory, positionManager)
 * pair.  Returns `undefined` for unknown pairs, invalid EIP-55 input,
 * or missing arguments.  When both addresses are syntactically valid
 * but the pair has no entry, emits a dedup'd `console.warn`.
 * @param {string|null|undefined} factory
 * @param {string|null|undefined} positionManager
 * @returns {{displayName:string, supportedBlockchainsByLpRangerAndLpProvider:string[]} | undefined}
 */
export function getProvider(factory, positionManager) {
  if (
    typeof factory !== "string" ||
    factory.length === 0 ||
    typeof positionManager !== "string" ||
    positionManager.length === 0
  )
    return undefined;
  const key = _compositeKey(factory, positionManager);
  if (key === null) return undefined;
  const entry = _providerMap[key];
  if (
    (entry === null || entry === undefined) &&
    !_loggedMissingProviders.has(key)
  ) {
    _loggedMissingProviders.add(key);
    log.warn(
      "[lp-providers] no entry for factory+positionManager pair %s — position will render without a provider label",
      key,
    );
  }
  return entry;
}

/**
 * Convenience: return only the short display label for a
 * (factory, positionManager) pair.  Undefined for unknown / invalid.
 * @param {string|null|undefined} factory
 * @param {string|null|undefined} positionManager
 * @returns {string | undefined}
 */
export function getProviderDisplayName(factory, positionManager) {
  return getProvider(factory, positionManager)?.displayName;
}

/**
 * Check whether an entry's supportedBlockchainsByLpRangerAndLpProvider
 * list includes the given canonical chain id.  Returns `false` for
 * unknown pairs, invalid chainIds, or entries that don't list the
 * chain.  Emits a dedup'd `console.warn` on the unsupported-chain
 * path (mirror of the server-side warning).
 * @param {string|null|undefined} factory
 * @param {string|null|undefined} positionManager
 * @param {string} chainId  Canonical chain id — KEY of chains.json.
 * @returns {boolean}
 */
export function isChainSupported(factory, positionManager, chainId) {
  const entry = getProvider(factory, positionManager);
  if (entry === null || entry === undefined) return false;
  if (typeof chainId !== "string" || chainId.length === 0) return false;
  const supported = Array.isArray(
    entry.supportedBlockchainsByLpRangerAndLpProvider,
  )
    ? entry.supportedBlockchainsByLpRangerAndLpProvider
    : [];
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
 * Legacy single-arg wrapper: return the short provider label for an
 * NFT position-manager address using the cached factory context.
 * Returns `undefined` before `setFactoryContext` has been called (i.e.
 * before the first `/api/status` poll) so the header stays clean.
 * @param {string|null|undefined} positionManager
 * @returns {string | undefined}
 */
export function getProviderLabel(positionManager) {
  if (_factory === null) return undefined;
  return getProviderDisplayName(_factory, positionManager);
}

/**
 * Paint the provider label (and its leading separator) for the given
 * NFT position-manager address using the cached factory context.
 * Missing/unknown contracts hide the wrapper.  Matches the deleted
 * signature so existing call sites (dashboard-events-manage,
 * dashboard-positions-store) don't need refactoring.
 * @param {string|null|undefined} positionManager  NFT position-manager address
 */
export function setProviderLabelFor(positionManager) {
  const wrap = g("wsProviderWrap");
  const label = g("wsProvider");
  if (wrap === null || label === null) return;
  const text = getProviderLabel(positionManager);
  if (typeof text === "string" && text.length > 0) {
    label.textContent = text;
    wrap.classList.remove("9mm-pos-mgr-hidden");
  } else {
    label.textContent = "";
    wrap.classList.add("9mm-pos-mgr-hidden");
  }
}
