/**
 * @file dashboard-gas-fee-settings.js
 * @description Settings popover handler for the global Gas Fee %
 * setting (the swap-gate ceiling shared by initial-rebalance, corrective,
 * and compound swap sites).  Extracted from dashboard-events.js to keep
 * that file under the project-wide 500-line cap.
 *
 * The ceiling is also clamped on every read by `gasFeePctToRatio` in
 * `src/swap-gates.js`, so a stale cached page can't disable the gate or
 * block all swaps.
 */

import { g, act } from "./dashboard-helpers.js";
import { saveConfigValues } from "./dashboard-config-save.js";

/**
 * Persist the global Gas Fee % to `/api/config`.  No-op if the input
 * isn't on the page.
 *
 * Sends what was typed: whether the figure is acceptable is decided by
 * `src/config-bounds.js` on the server, which refuses it with the
 * reason and has the field put back to the last accepted value.
 *
 * @returns {Promise<void>}
 */
export async function saveGasFeePct() {
  const inp = g("inGasFeePct");
  if (!inp) return;
  const raw = parseFloat(inp.value);
  await saveConfigValues({
    values: { gasFeePct: raw },
    inputs: { gasFeePct: "inGasFeePct" },
    onSaved: () =>
      act(
        "\u2705",
        "info",
        "Gas Fee % Saved",
        `Swap gate ceiling now ${raw}% across all positions`,
      ),
  });
}
