/**
 * @file dashboard-bot-settings-sync.js
 * @description One-line orchestrator for the per-poll Bot Settings
 * config-input syncs.  Extracted from `dashboard-data.js` when the
 * per-token slippage sync brought that file over the 500-line cap.
 *
 * Every function called here is idempotent and self-throttled against
 * dirty inputs and last-seen posKey, so calling this on every poll
 * (which is what `_syncManagedAndGlobals` in dashboard-data.js does)
 * is cheap.
 */

"use strict";

import {
  syncRangeWidth,
  syncFullRangeCheckbox,
} from "./dashboard-data-range-width.js";
import { syncPerTokenSlippage } from "./dashboard-per-token-slippage.js";

/**
 * Run every per-poll Bot Settings input sync in order.  Add new
 * syncs here rather than re-inflating dashboard-data.js.
 *
 * @param {object} data  Flattened poll payload (from flattenV2Status).
 */
export function syncBotSettingsConfigInputs(data) {
  syncRangeWidth(data);
  syncFullRangeCheckbox(data);
  syncPerTokenSlippage(data);
}
