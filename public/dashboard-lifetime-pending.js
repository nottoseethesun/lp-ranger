/**
 * @file public/dashboard-lifetime-pending.js
 * @description
 * Renders the Lifetime panel in "Pending Re-scan…" state. Used when the
 * bot's freshDeposits / lifetimeHodlAmounts cache is missing or the
 * per-deposit USD computation hasn't produced a positive total yet.
 *
 * Total Lifetime Deposit shows the explanatory label so the user
 * understands the value is pending; every lifetime field whose math
 * depends on the deposit (Net Profit, Price Change, IL/G, Profit) shows
 * an em-dash so the user isn't misled by partial numbers. Independent
 * lifetime fields (Fees Compounded, Gas, residuals, Realized Gains,
 * Current Value) are untouched — they're computed without the deposit
 * and are still accurate.
 *
 * Recovery loop lives in `src/bot-loop.js`: every 30 minutes, if
 * `totalLifetimeDepositUsd` is still zero, the bot re-triggers the
 * scan. On success, `_isLifetimeDepositPending` (in dashboard-data-kpi)
 * returns false and the normal renderer takes over.
 */
"use strict";

import { g } from "./dashboard-helpers.js";
import { setLeadingText } from "./dashboard-kpi-dom.js";

const _PENDING_LABEL = "Pending Re-scan…";
const _EM_DASH = "—";

const _BLANK_IDS = [
  "kpiNetPct",
  "kpiNetApr",
  "ltBdPriceChange",
  "netILPct",
  "netILApr",
];

const _DASH_LEADING_IDS = ["kpiNet", "ltProfit", "netIL"];

/** Set the Lifetime panel into pending-rescan state. */
export function _renderLifetimePending() {
  const dd = g("lifetimeDepositDisplay");
  if (dd) {
    dd.textContent = _PENDING_LABEL;
    dd.className = "kpi-value neu";
  }
  for (const id of _DASH_LEADING_IDS) {
    const el = g(id);
    if (el) setLeadingText(el, _EM_DASH);
  }
  for (const id of _BLANK_IDS) {
    const el = g(id);
    if (el) el.textContent = "";
  }
}
