/**
 * @file src/server-csrf.js
 * @description
 * CSRF token generation and verification for the LP Ranger HTTP server.
 * Uses the `csrf` package (pillarjs) for cryptographically secure tokens.
 *
 * Tokens expire after `tokenTtlMs` (loaded from `csrf.json` via the
 * layered defaults+user-override loader; operators override at
 * `app-config/user-configurable/csrf.json`, default 1 hour). The
 * server generates a secret at startup and creates tokens on demand
 * via `GET /api/csrf-token`. Mutating requests (POST, DELETE) must
 * include a valid, non-expired token in the `x-csrf-token` header.
 *
 * The token response also carries `refreshIntervalMs`, telling the
 * dashboard how often to proactively refresh its token so auto-fired
 * POSTs cannot expire silently on long-running servers.
 */

"use strict";

const { log } = require("./log");
const Tokens = require("csrf");
const {
  loadMergedDefaults,
  loadShippedDefaults,
} = require("./load-merged-defaults");

const _tokens = new Tokens();

const _FILENAME = "csrf.json";

/*- Single-source baseline: read the shipped JSON once at module init.
 *  Throws on missing/malformed file (install error, fail loudly).
 *  Used as the per-key fallback when an operator's live override fails
 *  validation.  See feedback_one_literal_per_shipped_default. */
const _FALLBACK = Object.freeze(loadShippedDefaults(_FILENAME));

/**
 * Read and parse `csrf.json`. On any error returns the built-in
 * fallback so callers never see invalid values.
 * @returns {{ tokenTtlMs: number, refreshIntervalMs: number }}
 */
function readCsrfTunable() {
  try {
    const p = loadMergedDefaults(_FILENAME);
    const out = { ..._FALLBACK };
    if (typeof p.tokenTtlMs === "number" && p.tokenTtlMs > 0)
      out.tokenTtlMs = p.tokenTtlMs;
    if (typeof p.refreshIntervalMs === "number" && p.refreshIntervalMs > 0)
      out.refreshIntervalMs = p.refreshIntervalMs;
    return out;
  } catch (err) {
    log.warn("[csrf] Falling back to built-in defaults: %s", err.message);
    return { ..._FALLBACK };
  }
}

/** Server-side secret — generated once at startup. */
const _secret = _tokens.secretSync();

/**
 * Issued tokens and their creation timestamps.
 * Pruned on each verify call to prevent unbounded growth.
 * @type {Map<string, number>}
 */
const _issued = new Map();

/** Max issued tokens before forced prune (safety cap). */
const _MAX_ISSUED = 500;

/**
 * Ring buffer of recent 403 rejections, keyed by `<METHOD> <url>` →
 * timestamp.  Used to detect a successful silent retry after the
 * dashboard's `fetchWithCsrf` refreshes its token: when a verify call
 * succeeds for a `(method, url)` that 403'd within
 * `_RETRY_LOG_WINDOW_MS`, we log a complementary
 * `[csrf] retry succeeded` line so the operator can confirm from logs
 * that the recovery worked (mirrors the existing
 * `[csrf] 403 ... — Expired/Unknown CSRF token` warning).
 *
 * Bounded — we keep at most one entry per `(method, url)` and prune on
 * insert + on successful match — so growth is O(distinct mutating
 * paths) regardless of session length.
 *
 * @type {Map<string, number>}
 */
const _recent403 = new Map();
const _RETRY_LOG_WINDOW_MS = 30_000;

/**
 * Create a new CSRF token and record its issue time.
 * @returns {{ token: string, expiresAt: number, refreshIntervalMs: number }}
 */
function createToken() {
  const { tokenTtlMs, refreshIntervalMs } = readCsrfTunable();
  const token = _tokens.create(_secret);
  const now = Date.now();
  _issued.set(token, now);
  _pruneExpired(now, tokenTtlMs);
  return { token, expiresAt: now + tokenTtlMs, refreshIntervalMs };
}

/**
 * Verify a CSRF token: cryptographically valid AND not expired.
 * @param {string|undefined} token  The token from the request header.
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyToken(token) {
  if (!token) return { valid: false, reason: "Missing x-csrf-token header" };
  if (!_tokens.verify(_secret, token))
    return { valid: false, reason: "Invalid CSRF token" };
  const issuedAt = _issued.get(token);
  if (!issuedAt) return { valid: false, reason: "Unknown CSRF token" };
  const { tokenTtlMs } = readCsrfTunable();
  if (Date.now() - issuedAt > tokenTtlMs)
    return { valid: false, reason: "Expired CSRF token" };
  return { valid: true };
}

/**
 * Remove expired tokens from the issued map.
 * @param {number} now          Current timestamp.
 * @param {number} tokenTtlMs   Token lifetime in ms.
 */
function _pruneExpired(now, tokenTtlMs) {
  if (_issued.size < _MAX_ISSUED) return;
  for (const [t, ts] of _issued) {
    if (now - ts > tokenTtlMs) _issued.delete(t);
  }
}

/**
 * Drop entries older than the retry-log window.  Called from both the
 * 403-record path (so the buffer can't keep stale matches around) and
 * the success path (so a long-quiet path doesn't permanently mask a
 * future retry).
 * @param {number} now
 */
function _prune403Buffer(now) {
  for (const [k, ts] of _recent403) {
    if (now - ts > _RETRY_LOG_WINDOW_MS) _recent403.delete(k);
  }
}

/**
 * Handle CSRF for a request: serve token on GET /api/csrf-token, verify on
 * mutating methods.  Returns `true` when the response has been sent.
 *
 * Logs `[csrf] retry succeeded for <METHOD> <url>` when a successful
 * verify lands on a `(method, url)` that recently 403'd — gives the
 * operator a clear signal that the silent token-refresh-and-retry in
 * `fetchWithCsrf` recovered, mirroring the existing
 * `[csrf] 403 ... — Expired/Unknown CSRF token` warning.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 * @param {(res, status, body) => void} jsonResponse
 * @returns {boolean}
 */
function handleCsrf(req, res, jsonResponse) {
  const { method, url } = req;
  if (method === "GET" && url === "/api/csrf-token") {
    jsonResponse(res, 200, createToken());
    return true;
  }
  if (method !== "GET" && method !== "OPTIONS") {
    const check = verifyToken(req.headers["x-csrf-token"]);
    const key = method + " " + url;
    const now = Date.now();
    if (!check.valid) {
      log.warn("[csrf] 403 %s %s — %s", method, url, check.reason);
      _prune403Buffer(now);
      _recent403.set(key, now);
      jsonResponse(res, 403, { ok: false, error: check.reason });
      return true;
    }
    const recent = _recent403.get(key);
    if (recent !== undefined && now - recent <= _RETRY_LOG_WINDOW_MS) {
      log.info("[csrf] retry succeeded for %s %s", method, url);
      _recent403.delete(key);
    } else if (recent !== undefined) {
      _recent403.delete(key);
    }
  }
  return false;
}

module.exports = { createToken, verifyToken, handleCsrf, readCsrfTunable };
