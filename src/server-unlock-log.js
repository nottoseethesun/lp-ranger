/**
 * @file server-unlock-log.js
 * @description Diagnostic logging helpers for `POST /api/wallet/unlock`.
 *
 * Extracted so the server.js route handler stays concise (server.js
 * is close to its 500-line cap). These helpers log every field that
 * could identify WHO submitted the unlock request: client IP,
 * Origin/Referer (which page or iframe dispatched the fetch),
 * User-Agent (browser vs curl/script), the Sec-Fetch-* headers
 * (tell us whether the request came from a user-gesture-driven
 * fetch, a prefetch, a same-site navigation, etc.), Content-Type,
 * and whether the custom CSRF header was present.
 *
 * All logs are namespaced `[unlock]`.  The namespace is inlined into
 * every format string via a template literal so that `src/log.js`'s
 * `_withTimestamp` sees a literal `[unlock]` at the start and injects
 * the timestamp AFTER it: `[unlock] [<timestamp>] POST ...`.  An
 * earlier version passed NS as a `%s` substitution argument, which
 * produced `[<timestamp>] [unlock] POST ...` (timestamp first —
 * wrong) because the `%s` placeholder defeated tag detection.
 */

"use strict";

const { log } = require("./log");
const NS = "[unlock]";

/** Summarize inbound request headers for the unlock trace log. */
function logUnlockRequest(req) {
  const h = req.headers || {};
  log.info(
    `${NS} POST /api/wallet/unlock — remote=%s origin=%s referer=%s ua=%s sec-fetch-site=%s sec-fetch-mode=%s sec-fetch-dest=%s content-type=%s has-csrf=%s`,
    req.socket ? req.socket.remoteAddress : "(no-socket)",
    h.origin || "(none)",
    h.referer || "(none)",
    h["user-agent"] || "(none)",
    h["sec-fetch-site"] || "(none)",
    h["sec-fetch-mode"] || "(none)",
    h["sec-fetch-dest"] || "(none)",
    h["content-type"] || "(none)",
    h["x-csrf-token"] ? "yes" : "no",
  );
}

/** Log the 400 rejection path (missing password in body). */
function logUnlockMissing() {
  log.warn(`${NS} POST /api/wallet/unlock rejected — missing password`);
}

/** Log that a password was provided before attempting to reveal. */
function logUnlockAttempt(pwLen) {
  log.info(
    `${NS} POST /api/wallet/unlock — password provided (len=%d), attempting reveal`,
    pwLen,
  );
}

/** Log a successful reveal, echoing origin + ua to fingerprint caller. */
function logUnlockSuccess(req) {
  const h = req.headers || {};
  log.info(
    `${NS} [server] Wallet unlocked via dashboard (caller origin=%s ua=%s)`,
    h.origin || "(none)",
    (h["user-agent"] || "(none)").slice(0, 60),
  );
}

/** Log the 401 path (reveal failed / wrong password). */
function logUnlockFail(err) {
  log.warn(
    `${NS} POST /api/wallet/unlock — reveal failed: %s`,
    err && err.message,
  );
}

module.exports = {
  logUnlockRequest,
  logUnlockMissing,
  logUnlockAttempt,
  logUnlockSuccess,
  logUnlockFail,
};
