/**
 * @file dashboard-rpc-endpoints.js
 * @description Fills the RPC URL control's preset menu, and its
 *   placeholder, from the endpoints the server actually uses.
 *
 *   The menu used to be three `<li data-rpc="…">` entries written into
 *   index.html. Two problems with that: config data does not belong in
 *   markup, and the list had already drifted — it offered an endpoint
 *   that is not in the failover chain at all, so the menu advertised
 *   something the bot would never use. Reading the list from
 *   `GET /api/rpc-endpoints` means the menu and the bot cannot disagree,
 *   and a fourth endpoint needs no HTML change.
 *
 *   Mirrors `dashboard-chart-providers.js`, which does the same for the
 *   chart links. The click handling stays in `dashboard-events.js`,
 *   which is already delegated over `[data-rpc]` and so needs no change.
 */

import { g } from "./dashboard-helpers.js";

/** Cached first endpoint, used as the input's placeholder. */
let _primaryUrl = "";

/**
 * The server's preferred endpoint, or "" before the fetch resolves.
 *
 * Exported so other modules can stop hardcoding a default URL of their
 * own — there should be exactly one literal for this value, and it
 * lives in chains.json.
 * @returns {string}
 */
export function getPrimaryRpcUrl() {
  return _primaryUrl;
}

/**
 * Build one preset row.
 *
 * `createElement` + `textContent` rather than an innerHTML string: the
 * label comes from config that an operator can edit, and building
 * markup from it by interpolation is the pattern the project's lint
 * rule exists to prevent.
 * @param {{url: string, label: string}} ep
 * @returns {HTMLLIElement}
 */
function _buildRow(ep) {
  const li = document.createElement("li");
  li.dataset.rpc = ep.url;
  li.textContent = ep.label;
  li.title = ep.url;
  return li;
}

/**
 * Fetch the endpoint list and render it into the preset menu.
 *
 * Failure is deliberately quiet: the combo is a free-text input, so an
 * empty menu costs the operator a dropdown, not the ability to set an
 * RPC. Logging it keeps the cause visible without a modal for something
 * this peripheral.
 * @returns {Promise<void>}
 */
export async function initRpcEndpoints() {
  const list = g("rpcList");
  if (!list) return;
  try {
    const res = await fetch("/api/rpc-endpoints");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { endpoints } = await res.json();
    if (!Array.isArray(endpoints) || endpoints.length === 0) return;

    list.replaceChildren(...endpoints.map(_buildRow));

    _primaryUrl = endpoints[0].url;
    const input = g("inRpc");
    /*- Placeholder only, never the value: an empty input means "use the
     *  configured default", and pre-filling it would make the operator's
     *  own saved choice indistinguishable from the shipped one. */
    if (input && !input.placeholder) input.placeholder = _primaryUrl;
    console.log(
      `[lp-ranger] RPC presets loaded: ${endpoints.length} endpoint(s), primary ${_primaryUrl}`,
    );
  } catch (e) {
    console.log("[lp-ranger] RPC preset list unavailable:", e.message);
  }
}
