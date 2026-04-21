/**
 * @file dashboard-data-poll.js
 * @description /api/status poll loop with concurrency guard. Skips the
 *   tick when a prior poll is still in flight so the status channel
 *   cannot exhaust Chrome's 6-per-origin socket pool while the server
 *   is pegged by a phase-2 event scan on a low-powered host.
 */

import { flattenV2Status } from "./dashboard-data-cache.js";
import { _setStatusPill } from "./dashboard-data-status.js";

let _onStatus = null;
let _dataTimerId = null;
let _pollFailCount = 0;
let _statusInFlight = false;
let _skippedPollCount = 0;

/** Register the callback that receives each flattened status payload. */
export function initDataPoll(onStatus) {
  _onStatus = onStatus;
}

function _onPollFail() {
  _pollFailCount++;
  if (_pollFailCount >= 3)
    _setStatusPill("status-pill danger", "dot red", "HALTED");
}

/*- Concurrency guard. When the server is slow (e.g. Pi 5 pegged by a
 *  phase-2 event scan) and status responses take longer than the 3 s
 *  poll interval, unguarded polls stack up and exhaust Chrome's
 *  6-per-origin socket pool — every new fetch then fails with
 *  ERR_INSUFFICIENT_RESOURCES. Sacrificing a tick when the prior poll
 *  hasn't returned is harmless: status is idempotent and the next tick
 *  picks up whatever changed. */
async function _pollStatus() {
  if (_statusInFlight) {
    _skippedPollCount++;
    /* Log once per 20 consecutive skips to avoid console spam. */
    if (_skippedPollCount % 20 === 1) {
      console.debug(
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
      _onPollFail();
      return;
    }
    _pollFailCount = 0;
    const data = flattenV2Status(await res.json());
    if (_onStatus) _onStatus(data);
  } catch (_) {
    _onPollFail();
  } finally {
    _statusInFlight = false;
  }
}

export function pollNow() {
  _pollStatus();
}

/** Start polling /api/status at 3s intervals. */
export function startDataPolling() {
  if (_dataTimerId) return;
  _pollStatus();
  _dataTimerId = setInterval(_pollStatus, 3000);
}

export function stopDataPolling() {
  if (_dataTimerId) {
    clearInterval(_dataTimerId);
    _dataTimerId = null;
  }
}
