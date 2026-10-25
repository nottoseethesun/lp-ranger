"use strict";

/**
 * @file util/migration/from-0.9.10/retire-price-move-retries.js
 * @description
 * A migration step: take out the settings for retrying a rebalance the
 * price outran, which releases up to 0.9.10 read.
 *
 * The price can leave a rebalance's new range before its mint, with the
 * old position already emptied. Those releases then tried the rebalance
 * again after a wait that grew with each such stop, and gave up after a
 * set number of them. This release does not try again: it holds the
 * position for the owner to weigh the impermanent loss and, if it is
 * acceptable, click Rebalance Now. It checks every setting at startup
 * and stops on one it does not read, so the old settings would stop the
 * server:
 *
 *   - app-runtime.json: `tx.retrySwapLimit`, `tx.swapBackoffBaseMs` and
 *     `tx.swapBackoffMaxMs`, and the note describing them, come out of
 *     the operator's copy, which is kept in `tmp/` first
 *     (util/migration/settings-copies.js);
 *   - `.env`: `REBALANCE_RETRY_SWAP_LIMIT` becomes a comment
 *     (util/migration/env-file.js).
 *
 * Runs on Node built-ins only, like the rest of the migration.
 */

const {
  dropKeys,
  migrationOptions,
  updateSettingsCopy,
} = require("../settings-copies");
const { retiredVariable, rewriteEnv } = require("../env-file");

const _WHY = "LP Ranger no longer retries a rebalance the price outran";

/** The copy's change: the retry settings out of its `tx` group. */
const _runtimeChange = (copy, v) =>
  dropKeys(
    copy.tx,
    [
      "retrySwapLimit",
      "_swapBackoff_comment",
      "swapBackoffBaseMs",
      "swapBackoffMaxMs",
    ],
    _WHY,
    v,
    "tx.",
  );

/** `.env`'s change: the retry limit made a comment. */
const _envChange = (line, s, v) =>
  s.name === "REBALANCE_RETRY_SWAP_LIMIT"
    ? retiredVariable(line, s.name, _WHY, v)
    : null;

/**
 * Take the retry settings out of the install's copy of app-runtime.json
 * and its `.env`.
 * @param {object} o
 * @param {string} o.root     The install's folder.
 * @param {boolean} o.dryRun  Report what would change, and change nothing.
 * @returns {string[]}  One line for each change, or none.
 */
function retirePriceMoveRetries({ root, dryRun }) {
  const o = migrationOptions(dryRun);
  return [
    ...updateSettingsCopy(root, "app-runtime.json", _runtimeChange, o),
    ...rewriteEnv({ root, dryRun }, _envChange),
  ];
}

module.exports = { retirePriceMoveRetries };
