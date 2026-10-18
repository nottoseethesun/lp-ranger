/**
 * @file dashboard-manage-check.js
 * @description Asks the server whether the position just put on screen is
 *   managed, and draws its Manage/Stop button from the answer.
 *
 *   `_activateCore` in `dashboard-positions.js` calls
 *   `checkManagedOnSwitch` for every position it puts on screen, before it
 *   repaints. The question is `GET /api/is-position-managed`, answered from
 *   the same list as the status poll's `managedPositions`. Until it is
 *   answered, `dashboard-manage-ui.js` draws the button disabled, so it
 *   never offers Manage or Stop on the strength of what was on screen
 *   before the switch. The answer goes into the browser's managed set,
 *   which the button is drawn from, and the next status poll replaces that
 *   set as usual.
 *
 *   A question that gets no usable answer is logged to the browser console
 *   and the button goes back to the managed set as the last status poll
 *   left it. A server that cannot answer this cannot answer a Manage or a
 *   Stop either, and its polls show that on the status pill.
 */

import { log } from "./dashboard-log.js";
import { compositeKey } from "./dashboard-helpers.js";
import { activeChainId } from "./dashboard-chain.js";
import { setPositionManaged } from "./dashboard-positions-store.js";
import {
  manageKey,
  setManagedCheckPending,
  paintManageUI,
} from "./dashboard-manage-ui.js";

/**
 * Ask the server whether `active` is managed, and repaint the Manage
 * button once it answers. Only NFT positions are asked about: the button
 * offers nothing for any other kind.
 *
 * Marks the question as sent before its first await, so a repaint the
 * caller makes straight after this call already draws the button
 * disabled.
 *
 * @param {object} active  posStore entry just put on screen.
 * @returns {Promise<void>}
 */
export async function checkManagedOnSwitch(active) {
  if (active.positionType !== "nft") return;
  const pendingKey = manageKey(active);
  const key = compositeKey(
    activeChainId(),
    active.walletAddress,
    active.contractAddress,
    active.tokenId,
  );
  setManagedCheckPending(pendingKey, true);
  try {
    const res = await fetch(
      "/api/is-position-managed?key=" + encodeURIComponent(key),
    );
    const body = await res.json();
    if (res.ok && typeof body.managed === "boolean") {
      setPositionManaged(active.tokenId, body.managed);
    } else {
      log.warn(
        "[lp-ranger] [manage] the server gave no answer to whether #%s is managed: HTTP %d %s",
        active.tokenId,
        res.status,
        body.error ?? "",
      );
    }
  } catch (err) {
    log.warn(
      "[lp-ranger] [manage] could not ask the server whether #%s is managed: %s",
      active.tokenId,
      err.message,
    );
  } finally {
    setManagedCheckPending(pendingKey, false);
    paintManageUI();
  }
}
