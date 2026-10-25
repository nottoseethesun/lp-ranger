"use strict";

/**
 * @file src/lib/server-address.js
 * @module server-address
 * @description
 * Where the dashboard server listens: PORT and HOST from the environment
 * or `.env`, else `server.port` and `server.host` in app-runtime.json,
 * each read by its rule in src/lib/env-settings.js.
 *
 * Kept apart from the rest of the app's settings (src/lib/runtime-flags.js)
 * so `npm stop` and `npm run gentle-stop` can find a running server
 * without reading a setting they do not use. An operator may have just
 * got one wrong, about to restart, and that must not keep them from
 * stopping the server that is running. Each answer is read when it is
 * asked for, so `npm stop` reads the port only when it has to look for
 * the server by its port. The app asks both at startup, through
 * src/lib/runtime-flags.js, so a wrong one still stops it there.
 */

const dotenv = require("dotenv");
const { loadMergedDefaults } = require("./load-merged-defaults");
const { readEnv } = require("./env-settings");

/*-
 *  Load `.env` if present, as src/lib/runtime-flags.js does; the stop scripts
 *  read it through here alone. Loading it twice changes nothing, since
 *  dotenv never replaces a variable already set.
 */
dotenv.config();

/**
 * The port the dashboard server listens on.
 * @returns {number}
 * @throws {Error} When PORT in `.env` is not a port, naming it.
 */
function serverPort() {
  return readEnv("PORT") ?? loadMergedDefaults("app-runtime.json").server.port;
}

/**
 * The network interface the dashboard server binds to; '127.0.0.1' is
 * this machine only.
 * @returns {string}
 * @throws {Error} When HOST in `.env` is not a host name or an IP address.
 */
function serverHost() {
  return readEnv("HOST") ?? loadMergedDefaults("app-runtime.json").server.host;
}

module.exports = { serverPort, serverHost };
