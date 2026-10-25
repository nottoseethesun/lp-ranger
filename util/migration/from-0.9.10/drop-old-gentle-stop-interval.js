"use strict";

/**
 * @file util/migration/from-0.9.10/drop-old-gentle-stop-interval.js
 * @description
 * A migration step: take a `npm run gentle-stop` interval this release
 * no longer allows out of the operator's copy of app-runtime.json.
 *
 * `shutdown.gentleStopPollMs` is how often gentle-stop asks the server
 * again. Release 0.9.10's gentle-stop asked every five minutes whether a
 * rebalance or compound was under way, so it shipped 300000. In this
 * release the server holds a gentle stop itself, and the command only
 * asks again and prints what the stop still waits for, so the setting's
 * range in setting-bounds.json is much shorter. A whole copy of 0.9.10's
 * file, as its README had operators make, holds the old value, which the
 * startup check would refuse. That value was for the old job, so it
 * comes out whenever it is longer than the range allows, and the shipped
 * default applies; a value within the range stays. The copy is kept in
 * `tmp/` first (util/migration/settings-copies.js).
 *
 * Runs on Node built-ins only, like the rest of the migration.
 */

const fs = require("fs");
const path = require("path");
const {
  isGroup,
  dropKeys,
  migrationOptions,
  updateSettingsCopy,
} = require("../settings-copies");

/** This release's longest gentle-stop interval, from its setting-bounds.json. */
function _longestInterval() {
  const file = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "app-config",
    "app-defaults-for-user-configurable",
    "setting-bounds.json",
  );
  const bounds = JSON.parse(fs.readFileSync(file, "utf8"));
  const longest = bounds.timers?.settings?.gentleStopPollMs?.max;
  if (typeof longest !== "number")
    throw new Error(
      `${file} names no longest gentle-stop interval (timers.settings.gentleStopPollMs.max)`,
    );
  return longest;
}

/** The copy's change: an interval longer than `longest`, taken out. */
function _change(copy, v, longest) {
  const shutdown = copy.shutdown;
  if (!isGroup(shutdown)) return [];
  const ms = shutdown.gentleStopPollMs;
  if (typeof ms !== "number" || ms <= longest) return [];
  return dropKeys(
    shutdown,
    ["gentleStopPollMs"],
    `${ms} is over the ${longest} ms this release allows, now that the ` +
      "server holds a gentle stop itself; the shipped default applies",
    v,
    "shutdown.",
  );
}

/**
 * Take a gentle-stop interval longer than this release allows out of the
 * install's copy of app-runtime.json.
 * @param {object} o
 * @param {string} o.root     The install's folder.
 * @param {boolean} o.dryRun  Report what would change, and change nothing.
 * @returns {string[]}  One line for each change, or none.
 */
function dropOldGentleStopInterval({ root, dryRun }) {
  const longest = _longestInterval();
  const o = migrationOptions(dryRun);
  return updateSettingsCopy(
    root,
    "app-runtime.json",
    (copy, v) => _change(copy, v, longest),
    o,
  );
}

module.exports = { dropOldGentleStopInterval };
