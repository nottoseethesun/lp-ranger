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
 *   `chainQueryTimeoutMs` (ui-defaults_non-layout_for-server-down-scenario.json)
 *   to answer. One that ends
 *   without a chain is logged to the browser console with what happened,
 *   and the server is asked again, until it answers. The server runs one
 *   chain for its whole life, so the answer holds until the page is
 *   reloaded. The same answer carries what the header's chain link
 *   shows (`paintChainLink`).
 */

import { log } from "./dashboard-log.js";
import { askUntilAnswered } from "./dashboard-ask-server.js";
/*-
 *  Bundled at build time rather than fetched: this wait bounds the
 *  dashboard's first question to the server, so it is needed before the
 *  server has answered anything.
 */
import SERVER_DOWN from "../../../app-config/app-defaults-for-user-configurable/ui-defaults_non-layout_for-server-down-scenario.json" with { type: "json" };

/*-
 *  The server's answer, `{ chainId, displayName, homepage, logo,
 *  tokenListUrl }`. Null until the server has answered; startup awaits
 *  that answer before anything reads it.
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
 * The active chain's name as people read it, e.g. `PulseChain`: the one
 * every position label and dialog line shows. Blank until the server has
 * named the chain, so a label leaves the chain out rather than show a
 * guess; startup learns it before any route or label is built.
 * @returns {string}
 */
export function activeChainDisplayName() {
  if (_chain === null) return "";
  const name = _chain.displayName;
  return typeof name === "string" ? name : "";
}

/**
 * Where the active chain's token logos are listed: the url of its token
 * list (`dashboard-token-logos.js`), or "" for a chain with none. The
 * page reads it once startup has learned the chain.
 * @returns {string}
 */
export function activeChainTokenListUrl() {
  const url = _chain.tokenListUrl;
  return typeof url === "string" ? url : "";
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

/** Why an answer to `GET /api/chain` names no chain, or null when it does. */
function _namesNoChain(body) {
  const id = body?.chainId;
  return typeof id === "string" && id.length > 0
    ? null
    : "its answer named no blockchain";
}

/**
 * Learn the active chain from the server, asking until it answers.
 * Awaited at startup before any position key or url is built.
 *
 * A request starts no sooner than `askEveryMs` after the one before it,
 * so a server that refuses at once is not asked in a tight loop.
 *
 * Each answer is reported to the caller as well as acted on: a request
 * that names no blockchain goes to `onUnanswered`, and the one that does
 * to `onAnswered`. Startup hands in the status poll's own counters, so a
 * dashboard that cannot learn its blockchain reads HALTED like one whose
 * polls go unanswered.
 *
 * @param {object} opts
 * @param {Function} opts.onUnanswered  Called once for each request that
 *   ends without naming a blockchain.
 * @param {Function} opts.onAnswered    Called once, when a request names
 *   it.
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
  onUnanswered,
  onAnswered,
  fetchFn = fetch,
  askEveryMs = SERVER_DOWN.chainQueryTimeoutMs,
  warnFn = log.warn,
}) {
  _chain = await askUntilAnswered({
    url: "/api/chain",
    refusal: _namesNoChain,
    logTag: "[chain]",
    asked: "asked the server for its blockchain",
    onUnanswered,
    onAnswered,
    fetchFn,
    askEveryMs,
    warnFn,
  });
  log.info("[chain] active chain: %s", _chain.chainId);
  return _chain.chainId;
}
