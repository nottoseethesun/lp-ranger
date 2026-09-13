/**
 * @file dashboard-rpc-endpoints.js
 * @description Renders the RPC endpoint list in Bot Settings → Network
 *   from the endpoints the server actually uses, and exposes the
 *   operator-added subset to the Add RPC dialog.
 *
 *   The control used to be an editable combo box: a free-text input
 *   with a preset dropdown. Two problems. The input saved on every
 *   `change` event, so a stray edit re-pointed the bot; and the list it
 *   dropped down looked selectable but only ever wrote into that input,
 *   which left "which endpoint am I actually on?" unanswered. It is now
 *   a read-only list showing the real failover order, with adding done
 *   deliberately through a dialog (`dashboard-rpc-add.js`).
 *
 *   The endpoint data comes from `GET /api/rpc-endpoints` rather than
 *   from markup, so the list and the bot cannot disagree and a fourth
 *   endpoint needs no HTML change.
 */

import { g } from "./dashboard-helpers.js";

/** Cached first endpoint, used by callers that build their own provider. */
let _primaryUrl = "";

/** Endpoints the operator added, newest first. Empty until loaded. */
let _saved = [];

/** The in-flight (or settled) load, so callers can wait for it. */
let _ready = null;

/**
 * The server's preferred endpoint, waiting for the list if it is still
 * loading.
 *
 * Exists because the synchronous getter has a window where it answers
 * "" — between page load and the endpoint list arriving. A caller that
 * built an ethers provider from that "" got one whose calls all throw,
 * and the nearest catch turned that into "this wallet has no on-chain
 * activity", i.e. an existing wallet reported as brand new. Waiting
 * removes the window; the only way to still get "" is the endpoint
 * request itself failing, which callers must handle as "unknown"
 * rather than as an answer.
 * @returns {Promise<string>}
 */
export async function rpcUrlReady() {
  if (_ready === null) initRpcEndpoints();
  await _ready;
  return _primaryUrl;
}

/**
 * The endpoints the operator added, newest first.
 *
 * The Add RPC dialog prepends to this list. It is the operator's own
 * list only — never the shipped endpoints — so that adding one does not
 * silently copy the shipped set into saved config, where it would then
 * stop tracking `chains.json`.
 * @returns {string[]}
 */
export function savedRpcUrls() {
  return [..._saved];
}

/**
 * Build one endpoint row.
 *
 * `createElement` + `textContent` rather than an innerHTML string: the
 * label comes from config that an operator can edit, and building
 * markup from it by interpolation is the pattern the project's lint
 * rule exists to prevent.
 * @param {{url: string, host: string, label: string, primary: boolean}} ep
 * @returns {HTMLLIElement}
 */
function _buildRow(ep) {
  const li = document.createElement("li");
  li.title = ep.url;
  const host = document.createElement("span");
  host.className = "9mm-pos-mgr-rpc-host";
  host.textContent = ep.host;
  const role = document.createElement("span");
  role.className = ep.primary
    ? "9mm-pos-mgr-rpc-role 9mm-pos-mgr-rpc-role-primary"
    : "9mm-pos-mgr-rpc-role";
  role.textContent = ep.primary ? "primary" : "failover";
  li.append(host, role);
  return li;
}

/**
 * Fetch the endpoint list and render it.
 *
 * Idempotent on first call only; use `refreshRpcEndpoints()` to pick up
 * a newly added endpoint.
 * @returns {Promise<void>}
 */
export async function initRpcEndpoints() {
  if (_ready !== null) return _ready;
  _ready = _loadEndpoints();
  return _ready;
}

/**
 * Re-fetch and re-render, after the operator adds an endpoint.
 *
 * The dialog does not render the new row itself: the server decides the
 * final order (duplicates are dropped, an endpoint already present is
 * promoted rather than repeated), so the list has to come back from the
 * server or it would show an order the bot does not use.
 * @returns {Promise<void>}
 */
export async function refreshRpcEndpoints() {
  _ready = _loadEndpoints();
  return _ready;
}

/**
 * Fetch the endpoint list and render it.
 *
 * Failure is deliberately quiet: an empty list costs the operator the
 * display, not the ability to run — the bot has its own copy. Logging
 * it keeps the cause visible without a modal for something this
 * peripheral.
 * @returns {Promise<void>}
 */
async function _loadEndpoints() {
  try {
    const res = await fetch("/api/rpc-endpoints");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { endpoints, saved } = await res.json();
    if (!Array.isArray(endpoints) || endpoints.length === 0) return;

    /*- Record the URL BEFORE touching the DOM.  `rpcUrlReady()` callers
     *  build providers from this; a missing list element must not cost
     *  them the endpoint, so the data lands first and the list is
     *  decoration on top of it. */
    _primaryUrl = endpoints[0].url;
    _saved = Array.isArray(saved) ? saved : [];

    const list = g("rpcList");
    if (list) list.replaceChildren(...endpoints.map(_buildRow));
    console.log(
      `[lp-ranger] RPC endpoints loaded: ${endpoints.length} endpoint(s), primary ${_primaryUrl}, ${_saved.length} added by operator`,
    );
  } catch (e) {
    console.log("[lp-ranger] RPC endpoint list unavailable:", e.message);
  }
}
