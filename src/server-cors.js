/**
 * @file src/server-cors.js
 * @description
 * CORS and cross-origin request guard for the LP Ranger HTTP server.
 *
 * Locks the `Access-Control-Allow-Origin` header to localhost and rejects
 * mutating requests (POST, DELETE) from foreign browser origins.  Programmatic
 * callers (curl, scripts) send no `Origin` header and pass through.
 */

"use strict";

/**
 * Return true when `origin` resolves to localhost at the expected port.
 * Matches `localhost`, `127.0.0.1`, and `[::1]` (IPv4 + IPv6 loopback).
 * @param {string} origin   The Origin header value.
 * @param {number} port     Expected server port.
 * @returns {boolean}
 */
function _isLocalhostOrigin(origin, port) {
  try {
    const u = new URL(origin);
    const loopback = ["localhost", "127.0.0.1", "[::1]"];
    return loopback.includes(u.hostname) && u.port === String(port);
  } catch {
    return false;
  }
}

/**
 * Set CORS headers, handle preflight, and reject cross-origin mutations.
 * Returns `true` when the response has already been sent (caller should return).
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 * @param {number}               port       Server port for the allowed origin.
 * @param {(res, status, body) => void} jsonResponse  JSON response helper.
 * @returns {boolean}
 */
function handleCors(req, res, port, jsonResponse) {
  const { method } = req;
  res.setHeader("Access-Control-Allow-Origin", `http://localhost:${port}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-csrf-token");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Reject cross-origin browser requests on mutating methods.
  // Programmatic callers (curl, scripts) send no Origin header and pass through.
  if (method !== "GET" && method !== "OPTIONS") {
    const origin = req.headers.origin;
    if (origin && !_isLocalhostOrigin(origin, port)) {
      jsonResponse(res, 403, { ok: false, error: "Forbidden: cross-origin" });
      return true;
    }
  }
  return false;
}

module.exports = { handleCors, _isLocalhostOrigin };
