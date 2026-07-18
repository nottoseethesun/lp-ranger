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
