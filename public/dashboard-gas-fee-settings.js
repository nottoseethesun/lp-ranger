/**
 * @file dashboard-gas-fee-settings.js
 * @description Settings popover handler for the global Gas Fee %
 * setting (the swap-gate ceiling shared by initial-rebalance, corrective,
 * and compound swap sites).  Extracted from dashboard-events.js to keep
 * that file under the project-wide 500-line cap.
 *
 * The ceiling is also clamped server-side on every read by
 * `gasFeePctToRatio` in `src/swap-gates.js`, so a stale cached page or
 * an out-of-range manual edit can't disable the gate or block all swaps.
 */

import { g, act, csrfHeaders } from "./dashboard-helpers.js";

/* Mirror src/swap-gates.js GAS_FEE_PCT_MIN / GAS_FEE_PCT_MAX so the UI
 * clamp matches the server's clamp.  If either bound moves, update both. */
const _MIN = 0.1;
const _MAX = 15;

/**
 * Persist the global Gas Fee % to `/api/config`.  No-op if the input
 * isn't on the page; toasts a "Save Failed" message on bad input or
 * server error so the operator gets feedback.
 */
export async function saveGasFeePct() {
  const inp = g("inGasFeePct");
  if (!inp) return;
  const raw = parseFloat(inp.value);
  if (!Number.isFinite(raw)) {
    act("\u274C", "error", "Save Failed", "Enter a number between 0.1 and 15");
    return;
  }
  const clamped = Math.min(_MAX, Math.max(_MIN, raw));
  if (clamped !== raw) inp.value = String(clamped);
  try {
    const r = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({ gasFeePct: clamped }),
    });
    if (r.ok) {
      act(
        "\u2705",
        "info",
        "Gas Fee % Saved",
        `Swap gate ceiling now ${clamped}% across all positions`,
      );
    } else {
      act("\u274C", "error", "Save Failed", `Server returned ${r.status}`);
    }
  } catch (err) {
    act("\u274C", "error", "Save Failed", err.message);
  }
}
