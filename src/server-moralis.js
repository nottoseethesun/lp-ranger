/**
 * @file src/server-moralis.js
 * @description Moralis API key validation and status-check route handler.
 * Extracted from server-routes.js to keep that file within the
 * max-lines budget.
 */

"use strict";

const { getApiKey } = require("./api-key-holder");
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
  console.log("[moralis] Validating key → GET %s", url);
  const r = await fetch(url, {
    headers: { Accept: "application/json", "X-API-Key": key },
  });
  const text = await r.text();
  if (r.ok) {
    console.log("[moralis] Key valid (status %d)", r.status);
    return "valid";
  }
  const isQuota = text.includes("usage") || r.status === 429;
  if (isQuota) {
    console.warn(
      "[moralis] Key valid but QUOTA exceeded (status %d): %s",
      r.status,
      text,
    );
    return "quota";
  }
  console.warn("[moralis] Key INVALID (status %d): %s", r.status, text);
  return "invalid";
}

/**
 * Validate Moralis key after decryption; log warnings.
 */
async function validateMoralisKey() {
  try {
    const status = await pingMoralis();
    if (!status) return;
    if (status === "invalid")
      console.warn("[server] Moralis API key INVALID — re-enter in Settings");
  } catch (err) {
    console.warn("[server] Moralis validation failed: %s", err.message);
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
    console.log("[moralis] Status check: %s", status);
    return jsonResponse(res, 200, { moralis: status });
  }
  try {
    const status = await pingMoralis();
    jsonResponse(res, 200, { moralis: status });
  } catch (err) {
    console.warn("[moralis] Status check failed: %s", err.message);
    jsonResponse(res, 200, { moralis: "invalid" });
  }
}

module.exports = { pingMoralis, validateMoralisKey, handleApiKeyStatus };
