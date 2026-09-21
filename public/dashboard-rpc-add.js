/**
 * @file dashboard-rpc-add.js
 * @description The writes behind Bot Settings → Network: the Add RPC
 *   dialog, and promoting an endpoint by picking it in the dropdown.
 *
 *   Both do the same thing to storage — prepend to the operator's own
 *   `rpcUrls` list — because `composeRpcUrls` drops duplicates keeping
 *   the earliest position, so prepending an endpoint already present
 *   promotes it rather than listing it twice.
 *
 *   Adding is deliberate: it commits on Save and on nothing else, and
 *   Save is the only thing that closes the dialog on success — a
 *   rejected URL leaves it open with what was typed still there. The
 *   control this replaced was a free-text combo box that saved on every
 *   `change` event, so a stray keystroke re-pointed every on-chain read
 *   the bot makes. A dropdown pick has no such failure mode, so it
 *   commits on change.
 *
 *   Either way the server owns the resulting order, so the dropdown is
 *   re-read from the server afterwards rather than patched here.
 */

import { g, fetchWithCsrf, act } from "./dashboard-helpers.js";
import {
  savedRpcUrls,
  savedRpcUrlsKnown,
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
 * Refuse to write when the current saved list is unknown.
 *
 * Both writers send the whole list with one entry prepended. If the
 * endpoint request failed, the list reads as empty and that prepend
 * would persist a list missing every endpoint the operator had already
 * added — deleting them, silently, on what looks like a successful
 * save. Reachable because the Add RPC button is static markup and opens
 * whether or not the load succeeded.
 * @returns {boolean}  True when it is safe to write.
 */
function _savedListUsable() {
  if (savedRpcUrlsKnown()) return true;
  const msg = "Endpoint list did not load — reload the page and try again.";
  _setError(msg);
  act("❌", "error", "Cannot Save", msg);
  return false;
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
  /*- Whether this is a usable endpoint is the server's question —
   *  `src/config-bounds.js` checks it with `validator.isURL` and names
   *  the entry it refused, and the catch below puts that sentence in
   *  the dialog's own error line. */
  if (!_savedListUsable()) return false;

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
 * Make an endpoint already in the list the primary.
 *
 * The dropdown's selected option IS the primary, so choosing a
 * different one has to move it to the front of the failover order. It
 * is sent the same way an addition is — prepended to the operator's own
 * list — because `composeRpcUrls` drops duplicates keeping the earliest
 * position, so prepending an endpoint that is already present promotes
 * it rather than listing it twice. That holds whether the endpoint came
 * from Add RPC or shipped in `chains.json`.
 * @param {string} url  The endpoint to promote.
 * @returns {Promise<boolean>}  True when the server accepted it.
 */
export async function promoteRpcUrl(url) {
  if (!url || !_savedListUsable()) return false;
  const urls = [url, ...savedRpcUrls().filter((u) => u !== url)];
  try {
    const res = await fetchWithCsrf("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rpcUrls: urls }),
    });
    const d = await res.json();
    if (d.ok === false) throw new Error(d.error || "Unknown error");
    console.log(`[lp-ranger] RPC primary set to: ${url}`);
    /*- Re-read rather than re-label in place: the server decides the
     *  resulting order, and the option text carries the role. */
    await refreshRpcEndpoints();
    act(
      "\u{1F517}",
      "info",
      "RPC Changed",
      `${url} is now the primary endpoint. In use immediately.`,
    );
    return true;
  } catch (err) {
    /*- Put the dropdown back on whatever the server actually holds.
     *  Leaving it showing an endpoint the bot is not using is how a
     *  control comes to look as though it works when it does not. */
    await refreshRpcEndpoints();
    act("❌", "error", "Change Failed", err.message);
    return false;
  }
}

/**
 * Wire the Network section's controls.
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
  _bindDropdown();
}

/** Open/close state lives on the element, so there is no flag to desync. */
function _setListOpen(open) {
  const list = g("rpcList");
  const btn = g("rpcCurrent");
  if (list) list.classList.toggle("open", open);
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
}

/**
 * Wire the endpoint dropdown: toggle, pick, and dismiss.
 *
 * A pick commits immediately — unlike the free-text field this control
 * replaced, every item is an endpoint that already exists, so there is
 * no typo to commit by accident.
 * @returns {void}
 */
function _bindDropdown() {
  const btn = g("rpcCurrent");
  const list = g("rpcList");
  if (!btn || !list) return;

  btn.addEventListener("click", () =>
    _setListOpen(!list.classList.contains("open")),
  );

  list.addEventListener("click", (e) => {
    /*- Delegated over the data attribute, never a class selector: these
     *  class names begin with a digit, which is legal in HTML but not in
     *  an unescaped CSS selector, so `closest(".9mm-…")` throws. */
    const li = e.target.closest("[data-rpc]");
    if (!li) return;
    _setListOpen(false);
    promoteRpcUrl(li.dataset.rpc);
  });

  /*- Dismiss on any click outside the control.  Bound on the document
   *  rather than on blur so a click that lands on the page background
   *  closes it too. */
  document.addEventListener("click", (e) => {
    if (!list.classList.contains("open")) return;
    if (e.target === btn || btn.contains(e.target) || list.contains(e.target))
      return;
    _setListOpen(false);
  });
}
