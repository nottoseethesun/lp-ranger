/**
 * @file src/dex-detail-page-url-generator.js
 * @module dexDetailPageUrlGenerator
 * @description
 * Builds the "Dex Detail Page" deep link shown above Chart Links in the
 * Pool Details dialog — e.g.
 * `https://dex.9mm.pro/info/v3/pulsechain/pairs/0x82db…`.
 *
 * Nothing in that URL is hard coded here. Every part is resolved from
 * config, and each part comes from whichever file actually owns it:
 *
 * | URL part            | Example  | Source                                                        |
 * | ------------------- | -------- | ------------------------------------------------------------- |
 * | scheme + FQDN       | `dex.9mm.pro` | `lp-providers.json` → entry → `dexDetailPage`             |
 * | literal segments    | `info`, `pairs` | `dexDetailPage.pathSegments`                           |
 * | `{swapProtocolVersion}` | `v3` | the SAME lp-providers entry's `swapProtocolVersion`         |
 * | `{blockchain}`      | `pulsechain` | active chain's `dexPairDetailPageUrl.blockchain` in chains.json |
 * | `{poolId}`          | `0x82db…`| left in the template; substituted client-side                 |
 *
 * Why the split: the domain and protocol version are properties of the
 * **LP provider** (the DEX runs the site and versions its own
 * protocol), so they key off `<poolFactory>_<positionManager>` — the
 * composite key `lp-providers.json` already uses, which is where the
 * NFT position-manager contract id lives. The blockchain slug is a
 * property of the **chain**, and is per-URL-type: DexTools uses
 * `pulse` where this pair page and DexScreener both use `pulsechain`,
 * so it cannot be shared with `chartProviders` even though some of
 * today's values coincide.
 *
 * The template shape and the `{poolId}`-left-for-the-client contract
 * deliberately mirror `src/chart-providers.js`, so the dashboard
 * substitutes both link families the same way.
 */

"use strict";

const { loadMergedDefaults } = require("./load-merged-defaults");

/**
 * Read the per-URL-type blockchain slug for a chain. Returns `null`
 * when the chain is unknown or the slug is missing/blank — an unknown
 * chain must yield no link rather than a wrong one.
 * @param {string} chainName  Canonical chain id — KEY of chains.json.
 * @returns {string|null}
 */
function _readChainSlug(chainName) {
  if (typeof chainName !== "string" || chainName.length === 0) return null;
  let chains;
  try {
    chains = loadMergedDefaults("chains.json");
  } catch {
    return null;
  }
  const chain = chains[chainName];
  if (chain === null || chain === undefined) return null;
  const cfg = chain.dexPairDetailPageUrl;
  if (cfg === null || cfg === undefined || typeof cfg !== "object") return null;
  const slug = cfg.blockchain;
  if (typeof slug !== "string" || slug.length === 0) return null;
  return slug;
}

/**
 * Substitute the non-pool placeholders into one path segment.
 * `{poolId}` is deliberately left intact for the client.
 * @param {string} segment
 * @param {{ blockchain: string, swapProtocolVersion: string }} values
 * @returns {string}
 */
function _resolveSegment(segment, values) {
  if (typeof segment !== "string") return "";
  return segment
    .replace("{blockchain}", values.blockchain)
    .replace("{swapProtocolVersion}", values.swapProtocolVersion);
}

/**
 * Validate the entry's `dexDetailPage` block and return it, or `null`
 * when it is absent or unusable. Split out of
 * `buildDexDetailPageUrlTemplate` to keep that function under the
 * complexity ceiling — extracted, never compacted.
 * @param {object|null|undefined} providerEntry
 * @returns {{scheme:string, domain:string, pathSegments:unknown[]}|null}
 */
function _readPage(providerEntry) {
  if (
    providerEntry === null ||
    providerEntry === undefined ||
    typeof providerEntry !== "object"
  )
    return null;
  const page = providerEntry.dexDetailPage;
  if (page === null || page === undefined || typeof page !== "object")
    return null;
  if (typeof page.scheme !== "string" || page.scheme.length === 0) return null;
  if (typeof page.domain !== "string" || page.domain.length === 0) return null;
  if (!Array.isArray(page.pathSegments)) return null;
  return page;
}

/**
 * Resolve the protocol version to substitute into the path.
 *
 * Only demands `swapProtocolVersion` when a segment actually asks for
 * it, so a provider whose detail page carries no version segment still
 * builds. Returns `null` when a segment needs the version and the
 * entry doesn't supply one, and `""` when no segment needs it.
 * @param {object} providerEntry
 * @param {unknown[]} pathSegments
 * @returns {string|null}
 */
function _resolveVersion(providerEntry, pathSegments) {
  const needsVersion = pathSegments.some(
    (s) => typeof s === "string" && s.includes("{swapProtocolVersion}"),
  );
  const version = providerEntry.swapProtocolVersion;
  const hasVersion = typeof version === "string" && version.length > 0;
  if (needsVersion && !hasVersion) return null;
  return hasVersion ? version : "";
}

/**
 * Build the Dex Detail Page URL template for one LP-provider entry on
 * one chain. The returned string still contains `{poolId}`.
 *
 * Returns `null` — meaning "render no link" — whenever any required
 * piece is missing or malformed: no `dexDetailPage` block, blank
 * scheme/domain, non-array `pathSegments`, missing
 * `swapProtocolVersion` while a segment asks for it, an unknown chain
 * slug, or a segment set that never yields a `{poolId}`. Failing
 * closed matters here: a half-resolved URL would silently send the
 * user to the wrong pool's page.
 *
 * @param {object|null|undefined} providerEntry  An `lp-providers.json` entry.
 * @param {string} chainName  Canonical chain id — KEY of chains.json.
 * @returns {string|null}
 */
function buildDexDetailPageUrlTemplate(providerEntry, chainName) {
  const page = _readPage(providerEntry);
  if (page === null) return null;

  const blockchain = _readChainSlug(chainName);
  if (blockchain === null) return null;

  const swapProtocolVersion = _resolveVersion(providerEntry, page.pathSegments);
  if (swapProtocolVersion === null) return null;

  const segments = page.pathSegments.map((s) =>
    _resolveSegment(s, { blockchain, swapProtocolVersion }),
  );
  if (segments.some((s) => s.length === 0)) return null;

  const url = `${page.scheme}://${page.domain}/${segments.join("/")}`;
  return url.includes("{poolId}") ? url : null;
}

/**
 * Resolve the display label for the link. Falls back to `null` when no
 * usable name is configured, so the caller can hide the row rather
 * than render an unlabelled anchor.
 * @param {object|null|undefined} providerEntry
 * @returns {string|null}
 */
function readDexDetailPageName(providerEntry) {
  const name = providerEntry?.dexDetailPage?.name;
  if (typeof name !== "string" || name.trim().length === 0) return null;
  return name.trim();
}

module.exports = {
  buildDexDetailPageUrlTemplate,
  readDexDetailPageName,
  _readChainSlug,
};
