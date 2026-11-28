/**
 * @file src/bot/dashboard-has-polled.js
 * @module dashboardHasPolled
 * @description
 * How long after the bot changes a position's state the dashboard can be
 * assumed to have polled at least once and seen it: the dashboard's poll
 * interval (src/lib/ui-defaults.js, the value the page is sent) times
 * `dashboard.pollsBeforeAssumedSeen` in app-runtime.json, whose comment
 * explains the figure.
 *
 * The bot waits this long before it retires a position whose re-open
 * failed, so the dashboard sees `rebalancePaused` and raises its alert
 * before the state is deleted, and before it clears a one-shot signal
 * (`oorRecoveredMin`, `rangeRounded`, `residualWarning`), so the
 * dashboard shows it once (src/bot/bot-loop.js). The bot's status report
 * carries the figure (src/bot/status-report.js), so the dashboard's
 * Manage button waits out the same retire. A server that refuses to
 * start waits as long before it exits, so open tabs show why
 * (src/server/server-routes.js `_exitRefused`, through the bot's
 * interface).
 */

"use strict";

const { readUiDefaults } = require("../lib/ui-defaults");
const { loadMergedDefaults } = require("../lib/load-merged-defaults");
const { SETTING_BOUNDS } = require("../lib/setting-bounds");
const { withinBound, boundText } = require("../lib/range-check");

/**
 * Work out how long the dashboard is given to see a change. Both reads
 * are memoized where they are made, so asking on every status poll costs
 * nothing after the first. The result becomes a timer, so the multiple
 * is held to its range in setting-bounds.json, which gives the reason
 * for it; the startup check (src/lib/settings-check.js) has already
 * refused one outside it.
 *
 * @returns {number} Whole milliseconds.
 * @throws {Error} When the multiple is outside its range, naming it.
 */
function guaranteedDashboardHasPolledMs() {
  const polls =
    loadMergedDefaults("app-runtime.json").dashboard?.pollsBeforeAssumedSeen;
  const bound = SETTING_BOUNDS.dashboard.pollsBeforeAssumedSeen;
  if (withinBound(polls, bound))
    return Math.round(readUiDefaults().dashboardPollIntervalMs * polls);
  throw new Error(
    "[bot] app-runtime.json → dashboard.pollsBeforeAssumedSeen must be " +
      `${boundText(bound)}; it is ${JSON.stringify(polls)}.`,
  );
}

module.exports = { guaranteedDashboardHasPolledMs };
