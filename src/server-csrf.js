/**
 * @file src/server-csrf.js
 * @description
 * CSRF token generation and verification for the LP Ranger HTTP server.
 * Uses the `csrf` package (pillarjs) for cryptographically secure tokens.
 *
 * Tokens expire after `tokenTtlMs` (loaded from
 * `app-config/static-tunables/csrf.json`, default 1 hour). The server
 * generates a secret at startup and creates tokens on demand via
 * `GET /api/csrf-token`. Mutating requests (POST, DELETE) must include
 * a valid, non-expired token in the `x-csrf-token` header.
 *
 * The token response also carries `refreshIntervalMs`, telling the
 * dashboard how often to proactively refresh its token so auto-fired
 * POSTs cannot expire silently on long-running servers.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Tokens = require("csrf");

const _tokens = new Tokens();

/** Built-in fallback when the tunable file is missing or malformed. */
const _FALLBACK = Object.freeze({
  tokenTtlMs: 60 * 60 * 1000,
  refreshIntervalMs: 5 * 60 * 1000,
});

const _TUNABLE_FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "static-tunables",
  "csrf.json",
);

/**
 * Read and parse `csrf.json`. On any error returns the built-in
 * fallback so callers never see invalid values.
 * @returns {{ tokenTtlMs: number, refreshIntervalMs: number }}
 */
function readCsrfTunable() {
  try {
    const raw = fs.readFileSync(_TUNABLE_FILE, "utf8");
    const p = JSON.parse(raw);
    const out = { ..._FALLBACK };
    if (typeof p.tokenTtlMs === "number" && p.tokenTtlMs > 0)
      out.tokenTtlMs = p.tokenTtlMs;
    if (typeof p.refreshIntervalMs === "number" && p.refreshIntervalMs > 0)
      out.refreshIntervalMs = p.refreshIntervalMs;
    return out;
  } catch (err) {
    console.warn("[csrf] Falling back to built-in defaults: %s", err.message);
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
 * Handle CSRF for a request: serve token on GET /api/csrf-token, verify on
 * mutating methods.  Returns `true` when the response has been sent.
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
    if (!check.valid) {
      console.warn("[csrf] 403 %s %s — %s", method, url, check.reason);
      jsonResponse(res, 403, { ok: false, error: check.reason });
      return true;
    }
  }
  return false;
}

module.exports = { createToken, verifyToken, handleCsrf, readCsrfTunable };
