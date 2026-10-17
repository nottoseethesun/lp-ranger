/**
 * @file dashboard-chain.js
 * @description The active chain, as the server names it — the key of its
 *   `chains.json` entry, and the first segment of every position key and
 *   every bookmarkable url.
 *
 *   Startup asks `GET /api/chain` before anything builds a key or
 *   registers a route, and waits for the answer. There is no guess to
 *   fall back on: a key built on the wrong chain files a position's
 *   settings where no bot reads them. Each request gets
 *   `chainQueryTimeoutMs` (ui-defaults.json) to answer. One that ends
 *   without a chain is logged to the browser console with what happened,
 *   and the server is asked again, until it answers. The server runs one
 *   chain for its whole life, so the answer holds until the page is
 *   reloaded. The same answer carries what the header's chain link
 *   shows (`paintChainLink`).
 */

import { log } from "./dashboard-log.js";
/*-
 *  Bundled at build time rather than fetched: this wait bounds the
 *  dashboard's first question to the server, so it is needed before the
 *  server has answered anything.
 */
import UI_DEFAULTS from "../app-config/app-defaults-for-user-configurable/ui-defaults.json" with { type: "json" };

/*-
 *  The server's answer, `{ chainId, displayName, homepage, logo }`.
 *  Null until the server has answered; startup awaits that answer before
 *  anything reads it.
 */
let _chain = null;

/**
 * The active chain's id, e.g. `pulsechain` or `pulsechain-testnet`.
 * @returns {string|null} Null only before `loadActiveChain` resolves.
 */
export function activeChainId() {
  return _chain === null ? null : _chain.chainId;
}

/**
 * Put the active chain's link in the header — its logo, linking to its
 * website — in the slot after the "on" that introduces it. Until the
 * server has named the chain the slot stays empty and the "on" hidden;
 * nothing stands in for them. The link is built here rather than written
 * into the markup, because an image and a link are not valid HTML until
 * they have a source and an address, and both come from the chain.
 */
export function paintChainLink() {
  const on = document.getElementById("chainLinkOn");
  const slot = document.getElementById("chainLink");
  if (_chain === null || on === null || slot === null) return;
  const img = document.createElement("img");
  img.src = _chain.logo;
  img.alt = _chain.displayName;
  img.className = "9mm-pos-mgr-header-logo 9mm-pos-mgr-chain-logo";
  const link = document.createElement("a");
  link.className = "9mm-pos-mgr-chain-link";
  link.href = _chain.homepage;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = "Visit " + _chain.displayName;
  link.appendChild(img);
  slot.replaceChildren(link);
  on.hidden = false;
}

/**
 * Ask the server once which chain it runs against.
 * @param {Function} fetchFn  The fetch to ask with.
 * @param {number} limitMs    How long the server has to answer.
 * @returns {Promise<{chain: object}|{chain: null, why: string}>} The
 *   server's answer, or what kept the request from naming a chain.
 */
async function _askServer(fetchFn, limitMs) {
  const signal = AbortSignal.timeout(limitMs);
  try {
    const res = await fetchFn("/api/chain", { signal });
    if (!res.ok) return { chain: null, why: `it answered HTTP ${res.status}` };
    const body = await res.json();
    const id = body?.chainId;
    if (typeof id === "string" && id.length > 0) return { chain: body };
    return { chain: null, why: "its answer named no blockchain" };
  } catch (err) {
    if (err?.name === "TimeoutError")
      return { chain: null, why: `no answer within ${limitMs / 1000} s` };
    return { chain: null, why: `it could not be reached (${err?.message})` };
  }
}

/**
 * Learn the active chain from the server, asking until it answers.
 * Awaited at startup before any position key or url is built.
 *
 * A request starts no sooner than `askEveryMs` after the one before it,
 * so a server that refuses at once is not asked in a tight loop.
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchFn]   The fetch to ask with; the
 *   browser's own unless a test passes a scripted one.
 * @param {number} [opts.askEveryMs]  How long each request has to
 *   answer, and the least time between two; the shipped
 *   `chainQueryTimeoutMs` unless a test passes its own.
 * @param {Function} [opts.warnFn]    Where an unanswered request is
 *   logged; the browser console unless a test passes its own.
 * @returns {Promise<string>} The active chain's id.
 */
export async function loadActiveChain({
  fetchFn = fetch,
  askEveryMs = UI_DEFAULTS.chainQueryTimeoutMs,
  warnFn = log.warn,
} = {}) {
  for (let attempt = 1; ; attempt++) {
    const askedAt = Date.now();
    const answer = await _askServer(fetchFn, askEveryMs);
    if (answer.chain !== null) {
      _chain = answer.chain;
      log.info("[chain] active chain: %s", _chain.chainId);
      return _chain.chainId;
    }
    warnFn(
      "[chain] attempt %d: asked the server for its blockchain; %s — asking again",
      attempt,
      answer.why,
    );
    const restMs = askEveryMs - (Date.now() - askedAt);
    if (restMs > 0) await new Promise((resolve) => setTimeout(resolve, restMs));
  }
}
