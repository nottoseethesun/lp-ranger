/**
 * @file src/server-csrf.js
 * @description
 * CSRF token generation and verification for the LP Ranger HTTP server.
 * Uses the `csrf` package (pillarjs) for cryptographically secure tokens.
 *
 * Tokens expire after {@link TOKEN_TTL_MS} (default 1 hour).  The server
 * generates a secret at startup and creates tokens on demand via
 * `GET /api/csrf-token`.  Mutating requests (POST, DELETE) must include
 * a valid, non-expired token in the `x-csrf-token` header.
 */

"use strict";

const Tokens = require("csrf");

const _tokens = new Tokens();

/** Token lifetime — 1 hour. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

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
 * @returns {{ token: string, expiresAt: number }}
 */
function createToken() {
  const token = _tokens.create(_secret);
  const now = Date.now();
  _issued.set(token, now);
  _pruneExpired(now);
  return { token, expiresAt: now + TOKEN_TTL_MS };
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
  if (Date.now() - issuedAt > TOKEN_TTL_MS)
    return { valid: false, reason: "Expired CSRF token" };
  return { valid: true };
}

/**
 * Remove expired tokens from the issued map.
 * @param {number} now  Current timestamp.
 */
function _pruneExpired(now) {
  if (_issued.size < _MAX_ISSUED) return;
  for (const [t, ts] of _issued) {
    if (now - ts > TOKEN_TTL_MS) _issued.delete(t);
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
      jsonResponse(res, 403, { ok: false, error: check.reason });
      return true;
    }
  }
  return false;
}

module.exports = { createToken, verifyToken, handleCsrf, TOKEN_TTL_MS };
