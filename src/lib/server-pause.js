/**
 * @file src/lib/server-pause.js
 * @module server-pause
 * @description
 * Server-tier wiring for the idle-driven price-lookup pause.  Lives in
 * its own module so `server.js` stays under the 500-line cap.
 *
 * Provides:
 *   - `createPauseInfra({ thresholdMs, checkIntervalMs })` — instantiates
 *     the server-side idle tracker, starts it, and returns
 *     `{ markActivity, stop, routes }`.  `routes` is a route-table
 *     fragment ready to be spread into the main `_routes` object.
 *
 * Wiring rules (from docs/architecture.md "Idle-Driven Price-Lookup
 * Pause"):
 *   - Every `/api/*` request EXCEPT `/health` calls `markActivity()` to
 *     reset the idle countdown.  `/health` is a load-balancer probe, not
 *     user activity.
 *   - `markActivity()` does NOT clear an existing pause flag — unpausing
 *     is always explicit (browser endpoint or move scope).
 *   - `POST /api/pause-price-lookups` and `POST /api/unpause-price-lookups`
 *     are idempotent.  Both also markActivity so the idle timer stays in
 *     sync with whatever the browser is doing.
 *   - `stop()` is invoked by the graceful-shutdown handler so the
 *     periodic check timer is cleared cleanly.
 */

"use strict";

const { createIdleTracker } = require("./server-idle-tracker");
const {
  pausePriceLookups,
  unpausePriceLookups,
} = require("./price-fetcher-gate");

/** Default thresholds — match docs/architecture.md. */
const DEFAULT_IDLE_THRESHOLD_MS = 15 * 60_000;
const DEFAULT_IDLE_CHECK_MS = 60_000;

/**
 * Build the pause infrastructure (idle tracker + two endpoints).
 *
 * @param {object} [opts]
 * @param {number} [opts.thresholdMs]
 * @param {number} [opts.checkIntervalMs]
 * @param {Function} [opts.jsonResponse]  Defaults to a minimal local impl.
 * @param {Function} [opts.readJsonBody]  Optional JSON body reader.  When
 *   provided, the pause/unpause endpoints will read `{ reason }` from the
 *   request body and forward it to the gate so the server log records
 *   why the transition happened (browser blur / no-input / focus / …).
 *   When omitted, the endpoints log `"browser request"` as the reason.
 * @returns {{ markActivity: () => void, stop: () => void, routes: object }}
 */
function createPauseInfra({
  thresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
  checkIntervalMs = DEFAULT_IDLE_CHECK_MS,
  jsonResponse,
  readJsonBody,
} = {}) {
  const tracker = createIdleTracker({
    thresholdMs,
    checkIntervalMs,
    onIdle: () => {
      pausePriceLookups(`server idle ${Math.round(thresholdMs / 60_000)}m`);
    },
  });
  tracker.start();

  /*- Pull the `{ reason }` field from the request body when a parser is
   *  available; fall back to a generic tag so the log line is always
   *  meaningful even if the browser omits the body. */
  async function _readReason(req, fallback) {
    if (!readJsonBody) return fallback;
    try {
      const body = await readJsonBody(req);
      const r = body && typeof body.reason === "string" ? body.reason : null;
      return r || fallback;
    } catch {
      return fallback;
    }
  }

  const routes = {
    "POST /api/pause-price-lookups": async (req, res) => {
      tracker.markActivity();
      const reason = await _readReason(req, "browser request");
      pausePriceLookups(`browser ${reason}`);
      jsonResponse(res, 200, { ok: true, paused: true });
    },
    "POST /api/unpause-price-lookups": async (req, res) => {
      tracker.markActivity();
      const reason = await _readReason(req, "browser request");
      unpausePriceLookups(`browser ${reason}`);
      jsonResponse(res, 200, { ok: true, paused: false });
    },
  };

  return {
    markActivity: () => tracker.markActivity(),
    stop: () => tracker.stop(),
    routes,
    /*- Test-only: expose the tracker for state inspection. */
    _tracker: tracker,
  };
}

module.exports = {
  createPauseInfra,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_IDLE_CHECK_MS,
};
