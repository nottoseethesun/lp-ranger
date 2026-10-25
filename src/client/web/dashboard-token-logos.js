/**
 * @file dashboard-token-logos.js
 * @description Each token's logo, to the left of its name, in two places:
 *   the Pool line at the top of the dashboard, and the row of token names
 *   atop the Price Range Monitor's Position Stats, smaller there.
 *
 *   The logos come from a token list. Each chain names its list in
 *   chains.json (`tokenList.url`), and the server passes the url on with
 *   the rest of the chain (`GET /api/chain`). A token list is a JSON file
 *   in the Uniswap token list format (https://tokenlists.org): a `tokens`
 *   array, each entry a token's contract `address` and, when it has a
 *   logo, the logo's own address, `logoURI`. On PulseChain the list is
 *   9MM's extended list, from https://github.com/ninemm-pro/app-tokens,
 *   whose README says how tokens and their logos are listed.
 *
 *   The page reads the list once, as it loads, straight from its url, and
 *   keeps each listed token's logo address by the token's contract
 *   address. Tokens are matched by address, never by symbol, since one
 *   symbol can name several tokens. Each logo then loads from its own
 *   address, as any image does. A token the list leaves out, a logo
 *   address that is not https, a chain with no list, a list that cannot
 *   be read, and a logo that fails to load all show a transparent
 *   placeholder instead, so every name keeps its place.
 */

import { log } from "./dashboard-log.js";
import { g } from "./dashboard-helpers.js";
import { activeChainTokenListUrl } from "./dashboard-chain.js";

/** A transparent 1 × 1 image: what a token with no logo shows. */
export const TOKEN_LOGO_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/*-
 *  Each listed token's logo address, by its contract address in lower
 *  case. Empty until the list has been read, and on a chain with none.
 */
let _logos = new Map();

/**
 * The logo addresses a token list gives, by lower-case contract address.
 * A token with no logo, or whose logo address is not https, is left out.
 * @param {object} list  A token list, as parsed from its JSON.
 * @returns {Map<string, string>}
 */
export function logosOfTokenList(list) {
  const logos = new Map();
  const tokens = Array.isArray(list?.tokens) ? list.tokens : [];
  for (const token of tokens) {
    const address = token?.address;
    const logo = token?.logoURI;
    if (typeof address !== "string" || typeof logo !== "string") continue;
    if (!logo.startsWith("https://")) continue;
    logos.set(address.toLowerCase(), logo);
  }
  return logos;
}

/**
 * Read the active chain's token list, once, as the page loads; until it
 * is read, every token shows the placeholder. A list that cannot be read
 * is logged to the browser console, and the placeholders stay.
 * @param {object} [opts]
 * @param {Function} [opts.fetchFn]  The fetch to read with; the
 *   browser's own unless a test passes a scripted one.
 * @param {Function} [opts.warnFn]   Where a failure is logged; the
 *   browser console unless a test passes its own.
 * @returns {Promise<void>} Settles once the list is read or has failed.
 */
export async function loadTokenLogos({
  fetchFn = fetch,
  warnFn = log.warn,
} = {}) {
  const url = activeChainTokenListUrl();
  if (url === "") return;
  try {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`the list's host answered HTTP ${res.status}`);
    const list = await res.json();
    _logos = logosOfTokenList(list);
    log.info("[token-logos] %d token logos from %s", _logos.size, url);
  } catch (err) {
    warnFn(
      "[token-logos] could not read the token list at %s (%s); every token shows a placeholder",
      url,
      err.message,
    );
  }
}

/**
 * Where a token's logo loads from: the list's logo address for it, or
 * the placeholder.
 * @param {string|undefined} address  The token's contract address.
 * @returns {string}
 */
export function tokenLogoSrc(address) {
  if (typeof address !== "string") return TOKEN_LOGO_PLACEHOLDER;
  return _logos.get(address.toLowerCase()) ?? TOKEN_LOGO_PLACEHOLDER;
}

/**
 * An image of a token's logo, for the left of its name. A logo that
 * fails to load is replaced by the placeholder.
 * @param {string|undefined} address  The token's contract address.
 * @param {object} [opts]
 * @param {boolean} [opts.small]  The smaller size, for Position Stats.
 * @returns {HTMLImageElement}
 */
export function tokenLogoImg(address, { small = false } = {}) {
  const img = document.createElement("img");
  img.className = small
    ? "9mm-pos-mgr-token-logo 9mm-pos-mgr-token-logo-sm"
    : "9mm-pos-mgr-token-logo";
  img.alt = "";
  img.addEventListener(
    "error",
    () => {
      img.src = TOKEN_LOGO_PLACEHOLDER;
    },
    { once: true },
  );
  img.src = tokenLogoSrc(address);
  return img;
}

/**
 * Write a pair's two tokens into a container, as the Pool line shows
 * them: each token's logo, then its full symbol. Each symbol is a span
 * of its own, so CSS can cut each one short on a narrow screen
 * (text-overflow and a max-width in `ch`, on `.9mm-pos-mgr-nft-bar-tok`
 * in 9mm-pos-mgr.css).
 * @param {string} elId  The container's id.
 * @param {string} t0Full  Token 0's symbol.
 * @param {string} t1Full  Token 1's symbol.
 * @param {string|undefined} t0Addr  Token 0's contract address.
 * @param {string|undefined} t1Addr  Token 1's contract address.
 */
export function paintTokenPair(elId, t0Full, t1Full, t0Addr, t1Addr) {
  const el = g(elId);
  if (el === null) return;
  const symbol = (text) => {
    const span = document.createElement("span");
    span.className = "9mm-pos-mgr-nft-bar-tok";
    span.textContent = text;
    span.title = text;
    return span;
  };
  el.replaceChildren(
    tokenLogoImg(t0Addr),
    symbol(t0Full),
    document.createTextNode(" / "),
    tokenLogoImg(t1Addr),
    symbol(t1Full),
  );
}

/**
 * Put each token's logo left of its name atop Position Stats, or the
 * placeholder in both places when no position is on screen.
 * @param {object|null} position  The position on screen, as the store
 *   holds it, or null.
 */
export function paintStatTokenLogos(position) {
  const slots = [
    ["statT0Logo", position?.token0],
    ["statT1Logo", position?.token1],
  ];
  for (const [id, address] of slots) {
    const slot = g(id);
    if (slot !== null)
      slot.replaceChildren(tokenLogoImg(address, { small: true }));
  }
}
