/**
 * @file src/server-error-guard.js
 * @description Global error handlers for transient RPC errors.
 *
 * Ethers can throw from internal timer callbacks (request timeouts) outside
 * any try/catch scope in the bot loop.  These handlers catch TIMEOUT,
 * NETWORK_ERROR, and SERVER_ERROR codes and log them as non-fatal warnings
 * instead of crashing the process.  All other uncaught errors still crash
 * immediately so real bugs aren't hidden.
 */

"use strict";

const { log } = require("./log");
const _RPC_CODES = new Set(["TIMEOUT", "NETWORK_ERROR", "SERVER_ERROR"]);

/** Install global uncaughtException + unhandledRejection handlers. */
module.exports = function installErrorGuard() {
  process.on("uncaughtException", (err) => {
    if (_RPC_CODES.has(err.code)) {
      log.warn("[server] Transient RPC error (non-fatal): %s", err.code);
      return;
    }
    log.error("[server] Uncaught exception:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    if (err && _RPC_CODES.has(err.code)) {
      log.warn("[server] Transient RPC rejection (non-fatal): %s", err.code);
      return;
    }
    log.error("[server] Unhandled rejection:", err);
    process.exit(1);
  });
};
