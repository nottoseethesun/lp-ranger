/**
 * @file dashboard-import-buttons.js
 * @description The one writer of whether Wallet Setup's buttons that
 *   send an import may be used now, from each status answer's
 *   `importWalletRefusal` (src/server/handle-api-status.js, painted by
 *   dashboard-data.js). While the server would refuse an import, as
 *   during a rebalance or compound, each is disabled, the refusal its
 *   tooltip. Each sits in a fieldset of its own (index.html), whose
 *   `disabled` adds to the button's own, so the checks of what was typed,
 *   which set the button's, are left as they are.
 */

import { g } from "./dashboard-helpers.js";

/*- The buttons that send an import: Seed Phrase's and Private Key's
 *  Import Wallet, and Generate New's Continue. */
const _IMPORT_BTN_IDS = ["seedImportBtn", "keyImportBtn", "genConfirmBtn"];

/**
 * Show whether an import may be sent now: each button's fieldset
 * disabled, and the refusal the button's tooltip, while the server would
 * refuse one; both cleared once it would not.
 * @param {string|null|undefined} refusal  The answer's `importWalletRefusal`.
 */
export function paintImportButtons(refusal) {
  const refused = typeof refusal === "string";
  for (const id of _IMPORT_BTN_IDS) {
    const btn = g(id);
    const gate = btn?.closest("fieldset");
    if (!gate) continue;
    gate.disabled = refused;
    btn.title = refused ? refusal : "";
  }
}
