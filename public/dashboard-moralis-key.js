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

/** Settings menu handler: saves using the cached session password. */
export async function saveMoralisKeyFromSettings() {
  const inp = g("moralisKeyInput");
  if (!inp || !inp.value.trim()) return;
  const saved = await saveMoralisApiKey(inp.value.trim(), null, inp);
  if (!saved) return;
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
  const row = box && box.closest(".9mm-pos-mgr-moralis-use-row");
  if (!box) return;

  const status = await checkMoralisKeyStatus();
  const hasKey = status !== "none";
  box.disabled = !hasKey;
  if (row) row.classList.toggle("disabled", !hasKey);

  /*- Read the saved value rather than assuming: the operator may have
   *  turned it off in a previous session.  Absent means on. */
  const saved = getLastStatus()?.global?.moralisEnabled;
  box.checked = hasKey && saved !== false;
  box.title = hasKey
    ? "Turn off to stop using the key without deleting it"
    : "Add a Moralis API key first";
}

/**
 * Persist the toggle and tell the operator what it changed.
 *
 * The server applies it to the running process as well as saving it, so
 * this takes effect on the next price lookup rather than at the next
 * restart.
 * @returns {Promise<void>}
 */
export async function saveMoralisEnabled() {
  const box = g("moralisEnabledToggle");
  if (!box || box.disabled) return;
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
  } catch (err) {
    /*- Put the switch back where it was: leaving it showing a state the
     *  server never accepted is how a setting comes to look as though
     *  it works when it does not. */
    box.checked = !on;
    act("\u274C", "error", "Save Failed", err.message);
  }
}
