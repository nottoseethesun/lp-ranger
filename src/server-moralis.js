/**
 * @file src/server-moralis.js
 * @description Moralis API key validation and status-check route handler.
 * Extracted from server-routes.js to keep that file within the
 * max-lines budget.
 */

"use strict";

const { log } = require("./log");
const { getApiKey, isServiceEnabled } = require("./api-key-holder");
const { hasEncryptedKey } = require("./api-key-store");

/**
 * Ping Moralis with the in-memory key; return "valid" | "invalid" | "quota".
 * Logs the request URL, status, and response body for diagnostics.
 * @returns {Promise<string|null>}
 */
async function pingMoralis() {
  const key = getApiKey("moralis");
  if (!key) return null;
  const url =
    "https://deep-index.moralis.io/api/v2.2/erc20" +
    "/0xA1077a294dDE1B09bB078844df40758a5D0f9a27/price?chain=0x171";
  log.info("[moralis] Validating key → GET %s", url);
  const r = await fetch(url, {
    headers: { Accept: "application/json", "X-API-Key": key },
  });
  const text = await r.text();
  if (r.ok) {
    log.info("[moralis] Key valid (status %d)", r.status);
    return "valid";
  }
  const isQuota = text.includes("usage") || r.status === 429;
  if (isQuota) {
    log.warn(
      "[moralis] Key valid but QUOTA exceeded (status %d): %s",
      r.status,
      text,
    );
    return "quota";
  }
  log.warn("[moralis] Key INVALID (status %d): %s", r.status, text);
  return "invalid";
}

/**
 * Validate Moralis key after decryption; log warnings.
 */
async function validateMoralisKey() {
  /*- Nothing to validate for a service the operator has switched off,
   *  and validating anyway spends one of their requests to learn the
   *  state of a key we are not going to use.  "Use Moralis Key: off"
   *  has to mean no Moralis traffic at all, or the switch is decorative. */
  if (!isServiceEnabled("moralis")) {
    log.info("[moralis] Skipping key validation — Use Moralis Key is off");
    return;
  }
  try {
    const status = await pingMoralis();
    if (!status) return;
    if (status === "invalid")
      log.warn("[server] Moralis API key INVALID — re-enter in Settings");
  } catch (err) {
    log.warn("[server] Moralis validation failed: %s", err.message);
  }
}

/**
 * Route handler: GET /api/keys/status — check Moralis key state.
 * @param {http.IncomingMessage} _req
 * @param {http.ServerResponse} res
 * @param {Function} jsonResponse
 */
async function handleApiKeyStatus(_req, res, jsonResponse) {
  const key = getApiKey("moralis");
  if (!key) {
    const stored = hasEncryptedKey("moralis");
    const status = stored ? "locked" : "none";
    log.info("[moralis] Status check: %s", status);
    return jsonResponse(res, 200, { moralis: status });
  }
  /*- A key exists but is switched off.  Report that without pinging:
   *  the dashboard calls this endpoint every time the Moralis dialog
   *  opens, so pinging here would mean the dialog for turning Moralis
   *  OFF spends a Moralis request each time it is opened. */
  if (!isServiceEnabled("moralis")) {
    log.info("[moralis] Status check: disabled (key present, not in use)");
    return jsonResponse(res, 200, { moralis: "disabled" });
  }
  try {
    const status = await pingMoralis();
    jsonResponse(res, 200, { moralis: status });
  } catch (err) {
    log.warn("[moralis] Status check failed: %s", err.message);
    jsonResponse(res, 200, { moralis: "invalid" });
  }
}

module.exports = { pingMoralis, validateMoralisKey, handleApiKeyStatus };
