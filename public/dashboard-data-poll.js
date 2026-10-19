/**
 * @file dashboard-data-poll.js
 * @description /api/status poll loop with concurrency guard. Skips the
 *   tick when a prior poll is still in flight so the status channel
 *   cannot exhaust Chrome's 6-per-origin socket pool while the server
 *   is pegged by a phase-2 event scan on a low-powered host.
 */

import { log } from "./dashboard-log.js";
import { flattenV2Status } from "./dashboard-data-cache.js";
import { _setStatusPill } from "./dashboard-data-status.js";
import { updateAllPositionsStatsBtn } from "./dashboard-all-positions-stats.js";
import { uiSetting } from "./dashboard-ui-settings.js";
/*-
 *  Built into the page: the HALTED count is needed while the server is
 *  not answering, which is when it cannot be asked for it. The poll
 *  interval and the skip-log spacing come from the server
 *  (`uiSetting`), which startup has asked before it starts polling.
 */
import SERVER_DOWN from "../app-config/app-defaults-for-user-configurable/ui-defaults_non-layout_for-server-down-scenario.json" with { type: "json" };

let _onStatus = null;
let _dataTimerId = null;
let _pollFailCount = 0;
let _statusInFlight = false;
let _skippedPollCount = 0;

/** Register the callback that receives each flattened status payload. */
export function initDataPoll(onStatus) {
  _onStatus = onStatus;
}

/**
 * Count a question the server left unanswered. The pill reads HALTED
 * once `pollFailuresBeforeHalted` go unanswered in a row. The questions
 * startup asks count, for the blockchain, the dashboard's settings and
 * the help's figures, and so does every status poll after them. A
 * dashboard that cannot learn its blockchain or its settings can show
 * nothing about any position, which is as halted as a server that stops
 * answering polls.
 */
export function countUnansweredQuestion() {
  _pollFailCount++;
  if (_pollFailCount >= SERVER_DOWN.pollFailuresBeforeHalted)
    _setStatusPill("status-pill danger", "dot red", "HALTED");
}

/**
 * Count a question the server answered, which ends any run of
 * unanswered ones. The pill itself is repainted by the next status poll.
 */
export function countAnsweredQuestion() {
  _pollFailCount = 0;
}

/*-
 *  Concurrency guard. When the server is slow (e.g. Pi 5 pegged by a
 *  phase-2 event scan) and status responses take longer than the poll
 *  interval, unguarded polls stack up and exhaust Chrome's
 *  6-per-origin socket pool — every new fetch then fails with
 *  ERR_INSUFFICIENT_RESOURCES. Sacrificing a tick when the prior poll
 *  hasn't returned is harmless: status is idempotent and the next tick
 *  picks up whatever changed.
 */
async function _pollStatus() {
  if (_statusInFlight) {
    _skippedPollCount++;
    // The first skip in a run is logged, then one in every `pollSkipLogEvery`.
    if ((_skippedPollCount - 1) % uiSetting("pollSkipLogEvery") === 0) {
      log.debug(
        "[lp-ranger] [poll] skipping tick — previous /api/status still in flight (skipped=%d)",
        _skippedPollCount,
      );
    }
    return;
  }
  _skippedPollCount = 0;
  _statusInFlight = true;
  try {
    const res = await fetch("/api/status");
    if (!res.ok) {
      countUnansweredQuestion();
      return;
    }
    countAnsweredQuestion();
    const data = flattenV2Status(await res.json());
    updateAllPositionsStatsBtn(data);
    if (_onStatus !== null) _onStatus(data);
  } catch (_) {
    countUnansweredQuestion();
  } finally {
    _statusInFlight = false;
  }
}

/**
 * Poll /api/status at once, outside the interval.
 * @returns {Promise<void>}  Settled once the answer is applied; at once
 *   when a poll is already in flight, whose answer then serves.
 */
export function pollNow() {
  return _pollStatus();
}

/**
 * Start polling /api/status every `dashboardPollIntervalMs`, a setting
 * the server sends; startup has it before it calls this.
 */
export function startDataPolling() {
  if (_dataTimerId) return;
  _pollStatus();
  _dataTimerId = setInterval(_pollStatus, uiSetting("dashboardPollIntervalMs"));
}

export function stopDataPolling() {
  if (_dataTimerId) {
    clearInterval(_dataTimerId);
    _dataTimerId = null;
  }
}
