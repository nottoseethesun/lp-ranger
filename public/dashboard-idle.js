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

import { fetchWithCsrf } from "./dashboard-helpers.js";

const PAUSE_AFTER_NO_INPUT_MS = 15 * 60_000;
const ACTIVITY_THROTTLE_MS = 500;
const STALE_MARGIN_MS = 2_000;

let _noInputTimer = null;
let _browserHasPaused = false;
let _lastActivityTs = 0;
let _lastActivityType = "activity";

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
  console.log("[dashboard] paused price lookups:", reason);
}

function _sendUnpause(reason) {
  _post("/api/unpause-price-lookups", reason);
  _browserHasPaused = false;
  console.log("[dashboard] unpaused price lookups:", reason);
}

/**
 * Arm (or re-arm) the no-input timer.  The callback closes over its own
 * `armedAt` so a stale firing delivered after Chrome unthrottles a
 * hidden tab is detected against THIS arming, not whatever module-level
 * value a subsequent re-arm has overwritten.
 */
function _armNoInputTimer() {
  if (_noInputTimer) clearTimeout(_noInputTimer);
  _noInputTimer = null;
  const armedAt = Date.now();
  _noInputTimer = setTimeout(() => {
    _noInputTimer = null;
    if (Date.now() - armedAt > PAUSE_AFTER_NO_INPUT_MS + STALE_MARGIN_MS)
      return;
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
  console.log("[dashboard] idle tracker started");
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
