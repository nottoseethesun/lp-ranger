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
 *   A position's provider is found from what its own key names: its
 *   position manager, and the chain (`getProviderFor`). A position
 *   manager is built against one pool factory, fixed on chain, so the
 *   contract and the chain pick out one entry, and no address the
 *   status answer carries outside a position's key is read.
 */

import { log } from "./dashboard-log.js";
import { g } from "./dashboard-helpers.js";
import { ethers } from "./ethers-adapter.js";
import { activeChainId } from "./dashboard-chain.js";

/**
 * In-memory cache populated once at init.  Keys are the raw JSON keys
 * from the server (canonical EIP-55 composite), values are entry
 * objects `{ displayName, supportedBlockchainsByLpRangerAndLpProvider }`.
 */
let _providerMap = {};

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
 * An address in EIP-55 checksum casing, or null when it is not one.
 * @param {*} address
 * @returns {string | null}
 */
function _checksum(address) {
  if (typeof address !== "string" || address.length === 0) return null;
  try {
    return ethers.getAddress(address);
  } catch {
    return null;
  }
}

/**
 * The provider list's entry for a position manager on the active chain:
 * the one entry whose key ends in that contract and whose supported
 * chains include this one.  Undefined until the chain is known, and when
 * the list holds no such entry, or more than one, which it never should,
 * since a position manager has one factory.
 * @param {string|null|undefined} positionManager  From the position's own key.
 * @returns {object | undefined}
 */
export function getProviderFor(positionManager) {
  const pm = _checksum(positionManager);
  const chain = activeChainId();
  if (pm === null || chain === null) return undefined;
  const found = Object.entries(_providerMap).filter(([key, entry]) => {
    const chains = entry?.supportedBlockchainsByLpRangerAndLpProvider;
    return (
      _checksum(key.split("_")[1]) === pm &&
      Array.isArray(chains) &&
      chains.includes(chain)
    );
  });
  if (found.length === 1) return found[0][1];
  const dedupKey = `${pm}::${chain}`;
  if (!_loggedMissingProviders.has(dedupKey)) {
    _loggedMissingProviders.add(dedupKey);
    log.warn(
      "[lp-providers] %d entries for position manager %s on %s — the position renders without a provider label",
      found.length,
      pm,
      chain,
    );
  }
  return undefined;
}

/**
 * The short provider label for a position manager on the active chain.
 * @param {string|null|undefined} positionManager  From the position's own key.
 * @returns {string | undefined}
 */
export function getProviderLabel(positionManager) {
  return getProviderFor(positionManager)?.displayName;
}

/**
 * Paint the provider label (and its leading separator) for the given
 * NFT position-manager address, from the provider list's entry for that
 * contract on the active chain.  Missing/unknown contracts hide the
 * wrapper.
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
