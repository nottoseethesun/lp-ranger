/**
 * @file dashboard-nft-providers.js
 * @description Fetches the NFT position-manager provider-label map from
 *   `GET /api/nft-providers` (backed by
 *   `app-config/static-tunables/nft-providers.json`) and exposes a
 *   setter that paints the label + leading dot separator next to the
 *   Fee Tier line.  Missing mappings hide the label entirely so the
 *   Fee Tier row stays clean.
 *
 *   Example: `0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2 → "9mm v3"`.
 */

import { log } from "./dashboard-log.js";
import { g } from "./dashboard-helpers.js";

/** In-memory cache populated once at init. Keys are lowercase addresses. */
let _providerMap = {};

/**
 * One-shot fetch of the provider map.  Fetch or parse errors leave the
 * cache empty so the provider label simply stays hidden — never blocks
 * the dashboard from rendering.
 * @returns {Promise<void>}
 */
export async function loadNftProviders() {
  try {
    const res = await fetch("/api/nft-providers");
    if (!res.ok) return;
    const data = await res.json();
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (typeof v === "string" && v.trim()) out[k.toLowerCase()] = v.trim();
    }
    _providerMap = out;
    log.info("[nft-providers] loaded %d mapping(s)", Object.keys(out).length);
  } catch (err) {
    log.warn("[nft-providers] fetch failed:", err && err.message);
  }
}

/**
 * Lookup the short provider label for an NFT contract address.
 * Returns the cached label (e.g. "9mm v3") or `undefined` when the
 * contract is unknown.  Case-insensitive.
 * @param {string|null|undefined} contractAddress
 * @returns {string | undefined}
 */
export function getProviderLabel(contractAddress) {
  const key = (contractAddress || "").toLowerCase();
  return key ? _providerMap[key] : undefined;
}

/**
 * Paint the provider label (and its leading separator) for the given
 * NFT contract address.  Missing/unknown contracts hide the wrapper.
 * @param {string|null|undefined} contractAddress  NFT position-manager address
 */
export function setProviderLabelFor(contractAddress) {
  const wrap = g("wsProviderWrap");
  const label = g("wsProvider");
  if (!wrap || !label) return;
  const text = getProviderLabel(contractAddress);
  if (text) {
    label.textContent = text;
    wrap.classList.remove("9mm-pos-mgr-hidden");
  } else {
    label.textContent = "";
    wrap.classList.add("9mm-pos-mgr-hidden");
  }
}
