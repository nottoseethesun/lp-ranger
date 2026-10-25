/**
 * @file dashboard-position-dialogs.js
 * @description The dialogs that belong to the position on screen, and
 *   closing them when another position comes on screen.
 *
 *   A dialog about a position is filled for the position on screen when
 *   it opens: its prices, its decimals, its IL baseline, a confirmation
 *   to rebalance or reload it or to save its slippage, a Compound Now
 *   waiting for its scan, a deposit typed into the Lifetime panel, a
 *   notice of what happened to it. Its Save or
 *   Confirm acts on whichever position is on screen when clicked, and
 *   another can come on screen underneath an open dialog, by the
 *   browser's Back or Forward button, say. So a switch to another
 *   position (`_activateCore`, dashboard-positions.js) closes them all,
 *   as the user ruled for every answer that is not about the position on
 *   screen: it is discarded. A rebalance moving the position to its new
 *   NFT is no such switch, since the same position stays on screen; and
 *   an alert the server raises names its own position and stays open
 *   (dashboard-alerts.js).
 *
 *   Each closes the way its own Cancel or Close does, so dismissal has
 *   one meaning per dialog: a slippage confirmation drops its pending
 *   save, and the IL Baseline dialog records that it was seen. The Escape
 *   key takes the dialogs' closers from the same list. A dialog built
 *   while the page runs carries `POSITION_DIALOG_ATTRIBUTE` when it
 *   belongs to a position, and is closed by its own dismiss control,
 *   unless its work is still running (`data-busy`).
 */

import { g } from "./dashboard-helpers.js";
import { closePriceOverrideDialog } from "./dashboard-price-override.js";
import { closeRebalanceConfirm } from "./dashboard-rebalance-confirm.js";
import { closeCompoundScanWait } from "./dashboard-compound.js";

/** Marks a dialog built while the page runs as belonging to a position. */
export const POSITION_DIALOG_ATTRIBUTE = "data-position-dialog";

/** Whether a dialog in the page is showing. */
const _shown = (id) => {
  const el = g(id);
  return el !== null && !el.classList.contains("hidden");
};

/*-
 *  The dialogs in the page that belong to the position on screen, each
 *  with the way it closes. Called through, never held, so a closer from
 *  another module is read when it runs.
 */
export const POSITION_MODALS = Object.freeze([
  { id: "rebalanceIlWarningModal", close: () => closeRebalanceConfirm() },
  { id: "compoundScanWaitModal", close: () => closeCompoundScanWait() },
  {
    id: "poolDetailsModal",
    close: () => g("poolDetailsModal")?.classList.add("hidden"),
  },
  { id: "hodlBaselineModal", close: () => g("hodlBaselineClose")?.click() },
  {
    id: "slippageAbove5ConfirmModal",
    close: () => g("slipAbove5CancelBtn")?.click(),
  },
  {
    id: "slippageAbove10TypeConfirmModal",
    close: () => g("slipAbove10CancelBtn")?.click(),
  },
  { id: "priceOverrideModal", close: () => closePriceOverrideDialog() },
]);

/*-
 *  The Lifetime and Current panels' inline editors, each open while it
 *  has the class `open`.
 */
const _INLINE_EDITORS = Object.freeze([
  "curDepositInputWrap",
  "curRealizedInputWrap",
  "initialDepositInputWrap",
  "lifetimeDaysInputWrap",
  "realizedGainsInputWrap",
]);

/** Close every dialog that belongs to the position on screen. */
export function closePositionDialogs() {
  for (const m of POSITION_MODALS) if (_shown(m.id)) m.close();
  for (const id of _INLINE_EDITORS) g(id)?.classList.remove("open");
  for (const dlg of document.querySelectorAll(
    `[${POSITION_DIALOG_ATTRIBUTE}]`,
  )) {
    if (dlg.dataset.busy) continue;
    // Its own dismissal first, so a confirmation answers no; then it goes.
    dlg.querySelector("[data-dismiss-modal]")?.click();
    dlg.remove();
  }
}
