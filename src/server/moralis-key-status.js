/**
 * @file src/server/moralis-key-status.js
 * @description The server's two checks of the stored Moralis key:
 * `GET /api/api-keys/status`, its state, which the key dialog shows each
 * time it opens, and the check logged once the wallet unlock has
 * decrypted it (`validateMoralisKey`). The request each sends Moralis is
 * src/lib/moralis-key.js.
 */

"use strict";

const { log } = require("../lib/log");
const { getApiKey, isServiceEnabled } = require("../lib/api-key-holder");
const { hasEncryptedKey } = require("../lib/api-key-store");
const { pingMoralis } = require("../lib/moralis-key");

/**
 * Route handler: GET /api/api-keys/status — check Moralis key state.
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

/**
 * Check the Moralis key once the wallet unlock has decrypted it, and log
 * a warning when Moralis refuses it, so the operator learns of a bad key
 * before a price lookup fails on it.
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

module.exports = { handleApiKeyStatus, validateMoralisKey };
