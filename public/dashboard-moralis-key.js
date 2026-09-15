/**
 * @file dashboard-moralis-key.js
 * @description Save + verify the Moralis API key from the Settings gear
 * menu.  Extracted from `dashboard-events.js` (which is right at its
 * `max-lines: 500` cap) so future events wiring can grow without paying
 * the line-budget tax.  All UI feedback goes through the `act()` toast
 * channel — no direct DOM writes.
 */

import {
  g,
  fetchWithCsrf,
  act,
  checkMoralisKeyStatus,
} from "./dashboard-helpers.js";
import { getLastStatus } from "./dashboard-data.js";

/**
 * POST the Moralis key to /api/api-keys and toast success/failure.
 * Exposed for direct callers (wallet-setup dialog, Settings menu).
 * @param {string} key  The API key to persist.
 * @param {string|null} pw  Optional wallet password (used when the
 *   session isn't yet unlocked and the server needs the encryption key
 *   passed inline; null when the cached session password is fine).
 * @param {HTMLElement|null} inp  Input element to clear on success.
 * @returns {Promise<boolean>}
 */
export async function saveMoralisApiKey(key, pw, inp) {
  const body = { service: "moralis", key };
  if (pw) body.password = pw;
  try {
    const res = await fetchWithCsrf("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (d.ok) {
      if (inp) inp.value = "";
      act(
        "\u{1F511}",
        "info",
        "API Key Saved",
        "Moralis key encrypted & saved",
      );
      return true;
    }
    act("❌", "error", "Save Failed", d.error || "Unknown error");
  } catch (err) {
    act("❌", "error", "Save Failed", err.message);
  }
  return false;
}

/**
 * Settings menu handler: saves using the cached session password.
 *
 * Returns whether the dialog is finished with, so the click handler can
 * close it.  Reported rather than closed here to keep this module from
 * importing the dialog module that already imports it.
 * @returns {Promise<boolean>}  True when Save completed — close the
 *   dialog.  False when it failed and the operator needs the dialog
 *   still open to correct something.
 */
export async function saveMoralisKeyFromSettings() {
  const inp = g("moralisKeyInput");
  if (!inp) return false;
  const key = inp.value.trim();

  /*- The switch is persisted here, by Save, and nowhere else.  It
   *  deliberately does NOT save on flip: everything else in this dialog
   *  commits on Save, and a control that writes the moment it is
   *  touched turns a mis-click into a settings change. */
  const switchSaved = await saveMoralisEnabled();

  if (!key) {
    /*- No key typed is a perfectly ordinary way to use Save — the
     *  operator came in to change the switch.  Silence would read as a
     *  broken button, so say what did happen. */
    if (switchSaved) await refreshMoralisToggle();
    return true;
  }

  const saved = await saveMoralisApiKey(key, null, inp);
  /*- Save failed: leave the dialog open so the operator still has the
   *  key they pasted and can try again. */
  if (!saved) return false;
  /*- A key now exists, so the Use-Moralis toggle stops being disabled.
   *  Refresh it here or the operator has to reopen the dialog to find
   *  the control they just earned. */
  await refreshMoralisToggle();
  const status = await checkMoralisKeyStatus();
  if (status === "valid") {
    act("✅", "info", "Moralis Key Valid", "API key verified — working");
  } else if (status === "quota") {
    act(
      "⚠️",
      "warning",
      "Moralis Quota Exhausted",
      "Key is valid but daily free-plan quota used up — resets tomorrow",
    );
  } else if (status === "invalid") {
    act(
      "⚠️",
      "warning",
      "Moralis Key Invalid",
      "Saved but Moralis rejected the key — check it",
    );
  }
  /*- The key was stored.  An invalid or quota-exhausted verdict is
   *  information, not a failed save, and the toast carries it — so the
   *  dialog is done either way. */
  return true;
}

/**
 * The `moralisEnabled` value the server currently holds.
 *
 * @returns {Promise<boolean|undefined>}  Undefined when unknown, which
 *   callers must read as "on" — absent has always meant enabled.
 */
async function _savedMoralisEnabled() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    return d?.global?.moralisEnabled;
  } catch {
    /*- Fall back to the polled copy; stale beats nothing. */
    return getLastStatus()?.global?.moralisEnabled;
  }
}

/**
 * Reflect the current key + toggle state into the dialog.
 *
 * The toggle answers "use the stored key?", which only means anything
 * when a key exists — so with no key it is disabled rather than shown
 * in some third state. A key that has never been toggled reads as on,
 * matching how the bot behaves.
 *
 * Called on dialog open, and again after a save, because saving a key
 * is exactly the moment the control becomes usable.
 * @returns {Promise<void>}
 */
export async function refreshMoralisToggle() {
  const box = g("moralisEnabledToggle");
  /*- Looked up by id, not by class.  These class names begin with a
   *  digit, which is legal in HTML but NOT in a CSS selector unless
   *  escaped — `closest(".9mm-…")` throws a DOMException, and it throws
   *  before the control is set, so the toggle would silently never
   *  reflect reality. */
  const row = g("moralisEnabledRow");
  if (!box) return;

  const status = await checkMoralisKeyStatus();
  const hasKey = status !== "none";
  box.disabled = !hasKey;
  if (row) row.classList.toggle("disabled", !hasKey);

  /*- Read the saved value from the server rather than from the last
   *  poll.  The polled copy is up to one interval stale, which shows up
   *  in two ways that both read as "the setting did not stick": opening
   *  the dialog before the first poll lands, and reopening it within a
   *  few seconds of toggling — where the stale copy would flip the
   *  switch back to its old position in front of the operator.
   *
   *  One extra request on a deliberate click is a fair price for the
   *  control never showing a state the server does not hold.  Falls
   *  back to the polled copy if that request fails. */
  const saved = await _savedMoralisEnabled();
  box.checked = hasKey && saved !== false;
  box.title = hasKey
    ? "Turn off to stop using the key without deleting it"
    : "Add a Moralis API key first";
}

/**
 * Persist the switch and tell the operator what changed.
 *
 * Called by Save, never by the switch itself — flipping it only changes
 * what the dialog shows until Save commits it, so a mis-click costs
 * nothing. The server applies it to the running process as well as
 * writing it to disk, so it takes effect on the next price lookup
 * rather than at the next restart.
 * @returns {Promise<boolean>}  True when a value was written.
 */
export async function saveMoralisEnabled() {
  const box = g("moralisEnabledToggle");
  /*- Disabled means no key, so there is no usage decision to record. */
  if (!box || box.disabled) return false;
  const on = box.checked;
  try {
    const res = await fetchWithCsrf("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moralisEnabled: on }),
    });
    const d = await res.json();
    if (d.ok === false) throw new Error(d.error || "Unknown error");
    console.log(`[lp-ranger] Moralis key usage set to ${on ? "on" : "off"}`);
    act(
      "\u{1F511}",
      "info",
      on ? "Moralis Enabled" : "Moralis Disabled",
      on
        ? "Price lookups will use your Moralis key."
        : "Price lookups will skip Moralis. Your key is kept.",
    );
    return true;
  } catch (err) {
    /*- Put the switch back where it was: leaving it showing a state the
     *  server never accepted is how a setting comes to look as though
     *  it works when it does not. */
    box.checked = !on;
    act("\u274C", "error", "Save Failed", err.message);
    return false;
  }
}
