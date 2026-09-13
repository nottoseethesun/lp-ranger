/**
 * @file dashboard-rpc-endpoints.js
 * @description Fills the RPC dropdown in Bot Settings → Network from
 *   the endpoints the server actually uses, and exposes the
 *   operator-added subset to `dashboard-rpc-add.js`.
 *
 *   The dropdown lists the endpoints in the order the bot walks them,
 *   and the SELECTED option is the primary — so the control answers
 *   "which endpoint am I on?" as well as offering the others. Picking a
 *   different one promotes it; adding a new one goes through a dialog.
 *   Both writes live in `dashboard-rpc-add.js`.
 *
 *   The control this replaced was an editable combo box whose text
 *   input saved on every `change` event, so a stray edit re-pointed
 *   every on-chain read the bot makes, and whose menu only ever wrote
 *   into that input.
 *
 *   The endpoint data comes from `GET /api/rpc-endpoints` rather than
 *   from markup, so the dropdown and the bot cannot disagree and a
 *   fourth endpoint needs no HTML change.
 */

import { g } from "./dashboard-helpers.js";

/** Cached first endpoint, used by callers that build their own provider. */
let _primaryUrl = "";

/** Endpoints the operator added, newest first. Empty until loaded. */
let _saved = [];

/** True once a load has actually succeeded — see savedRpcUrlsKnown. */
let _loaded = false;

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
 * Whether the saved list is actually known.
 *
 * Writers must check this. `_saved` starts empty and only fills on a
 * successful load, so an empty array means either "nothing added" or
 * "the request failed" — and the two are indistinguishable. Sending a
 * prepend built on the failed case would persist a list with the
 * operator's existing endpoints missing, deleting them. The Add RPC
 * button is static markup, so the dialog opens whether or not the load
 * succeeded; this is the guard that makes that safe.
 * @returns {boolean}
 */
export function savedRpcUrlsKnown() {
  return _loaded;
}

/**
 * Build one dropdown row.
 *
 * `createElement` + `textContent` rather than an innerHTML string: the
 * host comes from config that an operator can edit, and building markup
 * from it by interpolation is the pattern the project's lint rule
 * exists to prevent.
 *
 * Host and role are separate elements so the role can carry its own
 * colour. That is the whole reason this is a `<ul>` and not a
 * `<select>` — an `<option>` holds plain text, and its popup is drawn
 * by the OS, so neither striping nor a coloured PRIMARY survives there.
 * @param {{url: string, host: string, primary: boolean}} ep
 * @returns {HTMLLIElement}
 */
function _buildRow(ep) {
  const li = document.createElement("li");
  li.dataset.rpc = ep.url;
  li.title = ep.url;
  const host = document.createElement("span");
  host.className = "9mm-pos-mgr-rpc-host";
  host.textContent = ep.host;
  const role = document.createElement("span");
  role.className = ep.primary
    ? "9mm-pos-mgr-rpc-role 9mm-pos-mgr-rpc-role-primary"
    : "9mm-pos-mgr-rpc-role";
  role.textContent = ep.primary ? "PRIMARY" : "FAILOVER";
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
    _loaded = true;

    const list = g("rpcList");
    if (list) list.replaceChildren(...endpoints.map(_buildRow));
    /*- The closed control shows the primary, read from the server's
     *  order rather than from anything the browser remembers.  A stale
     *  browser-side selection would claim the bot is on an endpoint it
     *  is not. */
    const cur = g("rpcCurrentHost");
    if (cur) cur.textContent = endpoints[0].host;
    const btn = g("rpcCurrent");
    if (btn) btn.title = _primaryUrl;
    console.log(
      `[lp-ranger] RPC endpoints loaded: ${endpoints.length} endpoint(s), primary ${_primaryUrl}, ${_saved.length} added by operator`,
    );
  } catch (e) {
    console.log("[lp-ranger] RPC endpoint list unavailable:", e.message);
  }
}
