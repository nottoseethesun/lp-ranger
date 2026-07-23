/**
 * @file dashboard-idle.js
 * @description Browser-side idle detection for the idle-driven price-
 *   lookup pause (component 4 of 4 — see docs/architecture.md
 *   "Idle-Driven Price-Lookup Pause").
 *
 * One timer:
 *   - 15-min window of no input/activity → POST /api/pause-price-lookups
 *
 * The timer resets on any of the activity events listed below.  When
 * the browser believes itself paused, the next throttled activity event
 * also POSTs /api/unpause-price-lookups.
 *
 * The timer callback closes over its own arming timestamp so a stale
 * firing — Chrome unthrottling a long-deferred callback after a hidden-
 * tab interval — self-cancels rather than producing a spurious pause.
 * Without this guard, `clearTimeout` is occasionally too late: Chrome
 * may have already moved the long-deferred callback into the task queue,
 * and `clearTimeout` no longer cancels what's queued.
 *
 * The 3-second `/api/status` polling loop in dashboard-data.js is
 * intentionally orthogonal — it keeps polling whether paused or not,
 * and the server happily serves it from cached / last-known prices
 * without unpausing.
 */

import { log } from "./dashboard-log.js";
import { fetchWithCsrf } from "./dashboard-helpers.js";

const PAUSE_AFTER_NO_INPUT_MS = 15 * 60_000;
const ACTIVITY_THROTTLE_MS = 500;
const STALE_MARGIN_MS = 2_000;

let _noInputTimer = null;
let _browserHasPaused = false;
let _lastActivityTs = 0;
let _lastActivityType = "activity";

/*- Wake timestamp consulted by `isStaleForUiPurposes`.  Advances inside
 *  `_onActivity` ONLY when an activity event lands after a gap longer
 *  than `PAUSE_AFTER_NO_INPUT_MS` — i.e., the UI is transitioning back
 *  to awake after a long-idle / suspend window.  Monotonically advances
 *  and is never cleared; do not introduce a clearing path. */
let _uiLastWokeUpAtMS = Date.now();

/**
 * Activity event set.  Covers every gesture surface that real human use
 * produces — mouse, keyboard, scroll, touch, pointer.  `focus` is
 * critical: it must unpause BEFORE any subsequent click can route to a
 * server-tier view endpoint that needs fresh prices.
 */
const ACTIVITY_EVENTS = [
  "focus",
  "click",
  "mousedown",
  "mousemove",
  "wheel",
  "keydown",
  "touchstart",
  "touchend",
  "pointerdown",
];

function _post(url, reason) {
  try {
    fetchWithCsrf(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  } catch {
    /* best-effort */
  }
}

function _sendPause(reason) {
  if (_browserHasPaused) return;
  _post("/api/pause-price-lookups", reason);
  _browserHasPaused = true;
  log.info("[dashboard] paused price lookups:", reason);
}

function _sendUnpause(reason) {
  _post("/api/unpause-price-lookups", reason);
  _browserHasPaused = false;
  log.info("[dashboard] unpaused price lookups:", reason);
}

/**
 * Arm (or re-arm) the no-input timer.  The callback closes over its own
 * `armedAt` so a stale firing delivered after Chrome unthrottles a
 * hidden tab is detected against THIS arming, not whatever module-level
 * value a subsequent re-arm has overwritten.
 */
/**
 * Pure staleness check for the no-input timer callback.  A callback
 * counts as stale when `nowMs - armedAt` overruns the intended timer
 * duration by more than the 2-second grace margin — the Chrome
 * task-queue race after a long-throttled tab.  Extracted so tests
 * can drive the guard directly without needing to reproduce Chrome's
 * timer scheduling under Node.
 * @param {number} armedAt  Timestamp captured at arming (Date.now()).
 * @param {number} nowMs    Timestamp at callback firing (Date.now()).
 * @returns {boolean}       true → callback should bail (stale delivery).
 */
export function _isStaleFire(armedAt, nowMs) {
  return nowMs - armedAt > PAUSE_AFTER_NO_INPUT_MS + STALE_MARGIN_MS;
}

function _armNoInputTimer() {
  if (_noInputTimer) clearTimeout(_noInputTimer);
  _noInputTimer = null;
  const armedAt = Date.now();
  _noInputTimer = setTimeout(() => {
    _noInputTimer = null;
    if (_isStaleFire(armedAt, Date.now())) return;
    _sendPause("no-input 15m");
  }, PAUSE_AFTER_NO_INPUT_MS);
}

/**
 * Throttled activity handler.  Resets the no-input timer; if the
 * browser was paused, posts the unpause endpoint exactly once.  The
 * triggering event's `type` is captured in `_lastActivityType` so the
 * subsequent unpause POST can record which gesture broke the idle
 * (`focus`, `click`, `keydown`, `touchstart`, …).
 *
 * @param {Event} ev  DOM event from any of `ACTIVITY_EVENTS`.
 */
function _onActivity(ev) {
  if (ev && ev.type) _lastActivityType = ev.type;
  const now = Date.now();
  if (now - _lastActivityTs < ACTIVITY_THROTTLE_MS) return;
  /*- Wake-from-idle detection: any activity event arriving after a gap
   *  longer than the no-input threshold means the UI was effectively
   *  asleep — covers BOTH the normal browser-pause path (where
   *  `_sendUnpause` is about to run below) AND the system-suspend /
   *  tab-discard path where the no-input timer self-cancelled as stale
   *  and `_sendUnpause` never fired.  `focus` is the first entry in
   *  `ACTIVITY_EVENTS`, so on tab re-focus this runs synchronously
   *  before any pending poll response can be processed. */
  if (now - _lastActivityTs > PAUSE_AFTER_NO_INPUT_MS) {
    _uiLastWokeUpAtMS = now;
  }
  _lastActivityTs = now;
  _armNoInputTimer();
  if (_browserHasPaused) _sendUnpause(_lastActivityType);
}

/**
 * Bootstrap browser-side idle detection.  Idempotent — safe to call
 * once at dashboard init (additional calls are no-ops).
 */
let _started = false;
export function startBrowserIdleTracker() {
  if (_started) return;
  _started = true;
  for (const name of ACTIVITY_EVENTS) {
    window.addEventListener(name, _onActivity, { passive: true });
  }
  /*- Arm the no-input timer immediately so a tab opened-then-ignored
   *  eventually pauses without requiring a single gesture first. */
  _armNoInputTimer();
  log.info("[dashboard] idle tracker started");
}

/**
 * Current browser-side pause flag.  Read by other dashboard modules that
 * need to suppress idle-time work — e.g. `dashboard-sounds.js` skips
 * polling-driven event sounds while the dashboard is idle so a user
 * returning to a long-untouched tab is not greeted with a backlog of
 * rebalance/compound jingles.
 *
 * Item 4 of the four pause sources (move-scope `withFreshPricesAllowed`)
 * lives entirely server-side in `src/price-fetcher-gate.js` — it never
 * touches this flag, so an auto-rebalance/compound that fires while the
 * user is away leaves the browser still believing itself paused.
 *
 * @returns {boolean}
 */
export function isBrowserPaused() {
  return _browserHasPaused;
}

/**
 * Return `true` if `eventMs` predates the UI's most recent wake-up.
 * Used by `public/dashboard-sounds.js` to suppress polling-driven sound
 * effects for events that fired while the dashboard tab was idle or
 * suspended — the `isBrowserPaused` gate alone does not catch the
 * system-suspend case (JS frozen, polling stopped, seen-maps stale)
 * because on resume the seen-maps see "new" timestamps and the gate
 * has already been cleared by the wake activity event.
 *
 * Pure function.  Reads `_uiLastWokeUpAtMS`, never mutates it.
 *
 * @param {number} eventMs  Wall-clock ms (Date.now() comparable).
 * @returns {boolean}
 */
export function isStaleForUiPurposes(eventMs) {
  return eventMs < _uiLastWokeUpAtMS;
}
