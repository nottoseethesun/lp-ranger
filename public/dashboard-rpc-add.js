/**
 * @file dashboard-rpc-add.js
 * @description The Add RPC dialog in Bot Settings → Network.
 *
 *   Adding an endpoint is deliberate: it commits on Save and on nothing
 *   else. The control this replaced was a free-text combo box that
 *   saved on every `change` event, so a stray keystroke in the field
 *   re-pointed every on-chain read the bot makes. Save is also the only
 *   thing that closes the dialog on success — a rejected URL leaves it
 *   open with what was typed still there.
 *
 *   The added endpoint becomes the primary and the ones already listed
 *   stay behind it as failover. The server owns the final order
 *   (duplicates dropped, an endpoint already present promoted rather
 *   than repeated), so the list is re-read from the server afterwards
 *   rather than being patched here.
 */

import { g, fetchWithCsrf, act } from "./dashboard-helpers.js";
import {
  savedRpcUrls,
  refreshRpcEndpoints,
} from "./dashboard-rpc-endpoints.js";

/** Overlay element id. */
const _MODAL = "rpcAddModal";

/**
 * Show or clear the dialog's inline error.
 *
 * Inline as well as toasted: the toast is transient and the operator is
 * looking at the field they need to correct.
 * @param {string} msg  Message, or "" to clear.
 * @returns {void}
 */
function _setError(msg) {
  const el = g("rpcAddError");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("9mm-pos-mgr-initially-hidden", msg.length === 0);
}

/**
 * Validate an endpoint URL.
 *
 * Only shape is checked, not reachability: an endpoint can be down at
 * the moment it is added and fine a minute later, and the failover list
 * already handles one that never answers. Rejecting a typo'd scheme
 * here is worth it because that one never recovers.
 * @param {string} url  Raw operator input.
 * @returns {string|null}  Error message, or null when acceptable.
 */
export function validateRpcUrl(url) {
  if (!url) return "Enter an RPC URL.";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "That is not a valid URL.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Use an http:// or https:// endpoint.";
  }
  return null;
}

/**
 * Open the dialog, cleared and focused.
 * @returns {void}
 */
export function openRpcAddModal() {
  const m = g(_MODAL);
  if (!m) return;
  const inp = g("rpcAddInput");
  if (inp) inp.value = "";
  _setError("");
  m.classList.remove("hidden");
  if (inp) inp.focus();
}

/**
 * Close the dialog.
 * @returns {void}
 */
export function closeRpcAddModal() {
  const m = g(_MODAL);
  if (m) m.classList.add("hidden");
}

/**
 * Persist the typed endpoint as the new primary.
 *
 * Sends the operator's whole list, newest first, rather than just the
 * addition: `rpcUrls` is the stored value, and sending a delta would
 * make the server reconstruct a list it does not own.
 * @returns {Promise<boolean>}  True when saved — the caller closes the
 *   dialog. False when it failed and the operator needs it left open.
 */
export async function saveRpcAdd() {
  const inp = g("rpcAddInput");
  if (!inp) return false;
  const url = inp.value.trim();

  const invalid = validateRpcUrl(url);
  if (invalid) {
    _setError(invalid);
    return false;
  }

  /*- Prepend, so the newest addition is the primary.  An endpoint
   *  already in the list is not sent twice — the server drops
   *  duplicates, but sending a clean list keeps what is on disk
   *  readable. */
  const urls = [url, ...savedRpcUrls().filter((u) => u !== url)];

  try {
    const res = await fetchWithCsrf("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rpcUrls: urls }),
    });
    const d = await res.json();
    if (d.ok === false) throw new Error(d.error || "Unknown error");
    console.log(`[lp-ranger] RPC added as primary: ${url}`);
    await refreshRpcEndpoints();
    act(
      "\u{1F517}",
      "info",
      "RPC Added",
      `${url} is now the primary endpoint. In use immediately.`,
    );
    return true;
  } catch (err) {
    _setError(err.message);
    act("❌", "error", "Save Failed", err.message);
    return false;
  }
}

/**
 * Wire the dialog's three controls.
 *
 * The module announces itself rather than having `dashboard-events.js`
 * reach in and bind ids it does not own.
 * @returns {void}
 */
export function bindRpcAddEvents() {
  const pairs = [
    ["rpcAddBtn", openRpcAddModal],
    ["rpcAddCloseBtn", closeRpcAddModal],
    [
      "rpcAddSaveBtn",
      async () => {
        if (await saveRpcAdd()) closeRpcAddModal();
      },
    ],
  ];
  for (const [id, fn] of pairs) {
    const el = g(id);
    if (el) el.addEventListener("click", fn);
  }
}
