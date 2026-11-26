/**
 * @file src/server.js
 * @description
 * HTTP server and main entry point for LP Ranger, an EVM v3 Position Manager.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DISCLAIMER — USE AT YOUR OWN RISK
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT.  IN NO EVENT SHALL
 * THE AUTHORS, COPYRIGHT HOLDERS, OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM,
 * DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR
 * OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * By using this software you acknowledge that:
 *   - You are solely responsible for any financial losses, including loss of
 *     cryptocurrency or digital assets, resulting from use of this software.
 *   - Blockchain transactions are irreversible.  The authors cannot recover
 *     lost funds.
 *   - This software has not been formally audited and may contain bugs or
 *     vulnerabilities that could result in partial or total loss of funds.
 *   - You assume full responsibility for evaluating all risks, including
 *     smart-contract risk, impermanent loss, slippage, MEV attacks, oracle
 *     failures, and network congestion.
 *
 * DO NOT USE THIS SOFTWARE WITH FUNDS YOU CANNOT AFFORD TO LOSE.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The canonical engineering reference — environment variables, the
 * `app-config/` layout, development tools, the check-report pipeline,
 * debugging, and devdependencies — lives in docs/engineering.md.  The
 * sections below describe only the HTTP surface that server.js itself
 * implements.
 *
 *     ▸ docs/engineering.md     Canonical reference for configuration,
 *                               runtime state, and tooling.
 *     ▸ docs/architecture.md    High-level system architecture overview.
 *     ▸ docs/openapi.json       OpenAPI 3.0 spec for the routes below.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ROUTES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   GET  /                          → the dashboard: src/client/web/dist/index.html,
 *                                     or src/client/web/index.html before a build
 *   GET  /public/*                  → static files from src/client/web/
 *   GET  /health                    → 200 OK (load-balancers / pm2)
 *
 *   Status & Config
 *   GET  /api/status                → { global, positions: { [key]: {...} } }
 *   POST /api/config                → Update runtime config (throttle, slippage, etc.)
 *
 *   Wallet
 *   GET  /api/wallet/status         → Wallet address, lock state
 *   POST /api/wallet                → Import wallet (seed or private key)
 *   POST /api/wallet/unlock         → Decrypt wallet with password
 *   POST /api/wallet/reveal         → Return plaintext private key (requires password)
 *   DELETE /api/wallet              → Delete wallet file from disk
 *
 *   Positions
 *   POST /api/positions/scan        → Scan wallet for up to 300 LP positions
 *   POST /api/positions/refresh     → Re-read on-chain liquidity for scanned positions
 *   GET  /api/positions/managed     → List all managed positions with status
 *   POST /api/position/manage       → Start managing a position (tokenId)
 *   DELETE /api/position/manage     → Stop managing a position (composite key)
 *   POST /api/position/details      → Quick details: pool state, value, fees (Phase 1)
 *   POST /api/position/lifetime     → Lifetime P&L: event scan + epochs (Phase 2, slow)
 *   POST /api/position/scan-cancel  → Abort in-flight scan and reset sync flag (user escape hatch)
 *   POST /api/position/reload       → Wipe on-chain-derived state + re-scan from scratch (catastrophic-failure escape hatch)
 *   POST /api/position/rescan-prices → Re-value a managed position at fresh prices (bad-price escape hatch)
 *   GET  /api/position/:tokenId/history → Closed position historical P&L
 *
 *   UI
 *   GET  /api/ui-defaults           → Dashboard settings the server sends (shipped + override)
 *   GET  /api/lp-providers          → LP-provider metadata keyed by <factory>_<positionManager>
 *   GET  /api/bot-config-defaults   → Bot Settings defaults in force (shipped, override, .env)
 *   GET  /api/help-figures          → Figures the help quotes, as this install runs
 *   GET  /api/setting-labels        → Human-readable labels for config keys (Activity Log formatter)
 *
 *   Actions
 *   POST /api/rebalance             → Force-rebalance a position (positionKey)
 *   POST /api/compound              → Force-compound fees on a position (positionKey)
 *   POST /api/stop-when-all-clear   → Stop the server once nothing is under way (npm run gentle-stop)
 *
 *   Full OpenAPI 3.0 spec: docs/openapi.json
 *   Interactive docs:      npm run api-doc → http://localhost:5556
 *
 * @example
 * // .env
 * PORT=5555
 * HOST=127.0.0.1
 *
 * // start dashboard:
 * node src/server.js          // → http://localhost:5555
 *
 * // start the headless bot (PRIVATE_KEY, or the imported wallet unlocked
 * // by WALLET_PASSWORD or a password typed at the terminal; no key in a
 * // dry run):
 * node src/bot.js
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ROAD MAP
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * See README.md § Road Map for planned features.
 */

"use strict";

const cliHelp = require("./server/server-cli-help");

/*- `--help` answers and leaves, ahead of every other line in this file.
 *  It starts no server, so it must not open the operator's log file and
 *  must not announce a start — and the help text it prints names
 *  `npm run build-and-start`, so a start banner above it read as though
 *  the server it describes was already up. */
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  cliHelp("server");
  process.exit(0);
}

/*- Boot wiring for the --log-file CLI flag + logging.json static
 *  tunable.  MUST run before any log output so the file captures the
 *  startup banner.  No-op when neither source opts in.  See
 *  src/lib/boot-log-file.js + src/lib/log-file.js. */
require("./lib/boot-log-file").bootLogFile();

/*-
 *  Every setting is checked before any is read: the JSON settings files
 *  with the operator's copies, `.env` and bot-config.json. A wrong one
 *  stops the server here, each named, rather than leaving it to run on a
 *  value nobody chose. See src/lib/settings-check.js.
 */
require("./lib/settings-check").refuseToStartOnBadSettings();

/*-
 *  The dashboard settings, read now, just checked, and kept for the life
 *  of the process (src/lib/ui-defaults.js), so an edit to the operator's
 *  copy takes effect at the next restart, where the check above refuses
 *  a bad value.
 */
require("./lib/ui-defaults").readUiDefaults();

const { log } = require("./lib/log");
const { resetErrorLog } = require("./lib/error-log");
const { writePidFile } = require("./server/server-pid");
const { readShutdownTimings } = require("./lib/shutdown-timing");
// First statement of a real run — `--help` has already exited above, so
// nothing logs before this and it always tops the log.  Black on light gray (inverse of
// bot.js), rocket emoji before and after "Started."  ANSI: 30=black fg,
// 47=lt-gray bg, 0=reset.
log.info(
  "\x1b[30;47m[lp-ranger server] \uD83D\uDE80 Started. \uD83D\uDE80\x1b[0m",
);

const installServerErrorGuard = require("./server/server-error-guard");

const _headless = process.argv.includes("--headless");

const http = require("http");
const fs = require("fs");
const path = require("path");

const config = require("./lib/config");
const { handleCors } = require("./server/server-cors");
const { handleCsrf } = require("./server/server-csrf");
const walletManager = require("./lib/wallet-manager");
const { bigIntReplacer } = require("./lib/bigint-json");
const {
  loadConfig,
  backUpSettings,
  managedKeys,
} = require("./lib/bot-config-v2");
const { parseCompositeKey } = require("./lib/composite-key");
const { migrateAppConfig } = require("./lib/migrate-app-config");
const { userConfigurableRoutes } = require("./server/user-configurable-routes");
const { createPauseInfra } = require("./server/server-pause");
const { createUnlockHandler } = require("./server/server-unlock");
const { createWalletInUse } = require("./server/wallet-in-use");
const { createWalletClearRoute } = require("./server/wallet-clear");
const { logVersionBanner } = require("./server/build-info");
const { createBot } = require("./bot/bot-interface");

/*-
 * First log: version/commit banner for support triage. Logged before
 * any other startup work so it is always at the top of the server log.
 */
logVersionBanner("[server]");

// ── app-config migration ─────────────────────────────
/*-
 *  One-time move of legacy root-level config files into app-config/.
 *  Idempotent: a no-op after the first successful run. See
 *  src/lib/migrate-app-config.js and "The app-config Directory" in
 *  docs/engineering.md.
 */
migrateAppConfig();

// ── MIME type map ────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
};

// ── Bot config persistence (v2) ─────────────────────

/*-
 *  Bot config loaded from disk. Loaded without the safety copies, which
 *  the server makes once it holds its port (`backUpSettings`, below).
 */
const _diskConfig = loadConfig(undefined, true);

// ── The bot ─────────────────────────────────────────
/*-
 *  Built through its interface (src/bot/bot-interface.js), the one module
 *  of the bot this server loads: it puts the rpc endpoints into service
 *  before any route can run, reads the price library's cache lifetimes,
 *  and seeds today's per-pool rebalance counts from the rebalance log.
 *  Every route below asks it for what it needs, through the same
 *  interface, and the server holds none of its state.
 */
const _bot = createBot({
  diskConfig: _diskConfig,
  walletManager,
  skipBackups: true,
});

const _managedAtStartup = managedKeys(_diskConfig);
if (_managedAtStartup.length > 0)
  log.info(
    "[server] Loaded bot config (%d managed positions)",
    _managedAtStartup.length,
  );
/*- One line per saved position, written for whoever is reading the log
 *  rather than for whoever wrote it.
 *
 *  Identified by NFT id, which is what the dashboard shows and what an
 *  operator recognises.  The composite key's other three parts are the
 *  chain, the wallet and the position manager, identical on every line
 *  of a given install — printing the key's last ten characters led with
 *  the tail of a contract address, so every line opened with the same
 *  meaningless `7f2-`.
 *
 *  Three states have to be told apart, and only two of them are a
 *  status: `running` and `stopped` are positions the bot has been given,
 *  while a slot with no status was never managed at all.  Saving a
 *  setting from the dashboard creates that position's slot whether or
 *  not the bot ever ran it, so such a slot is settings waiting for a
 *  position that may yet be managed.  It used to print as "MISSING",
 *  which reads as something absent that ought to be present. */
for (const [k, v] of Object.entries(_diskConfig.positions || {})) {
  const parsed = parseCompositeKey(k);
  /*- A key that does not parse is reported as what it is rather than
   *  dressed up as an NFT id, since calling it one would hide the real
   *  problem: a slot nothing in the app could have written. */
  const label = parsed ? `NFT #${parsed.tokenId}` : `unparsable key ${k}`;
  log.info(
    "[server] Config position %s: %s — saved settings: %s",
    label,
    v.status || "never managed",
    Object.keys(v).join(","),
  );
}

// ── Static file helper ──────────────────────────────

/**
 * Resolve a URL path to a file under `src/client/web/`,
 * read it, and write it to `res`.
 * Returns false, with nothing written, if the file does not exist
 * (the caller then sends the dashboard for a path with no extension,
 * else a 404).
 * @param {string}              urlPath
 * @param {http.ServerResponse} res
 * @returns {boolean}
 *   true if it answered: with the file, or with a 400, 403 or 500
 */
function serveStatic(urlPath, res) {
  // Normalise: strip query string, percent-decode (so filenames with
  // spaces resolve), collapse '..' via path.resolve below.
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split("?")[0]);
  } catch (_) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("400 Bad Request");
    return true;
  }
  /*- Prefer the build-inlined `src/client/web/dist/index.html` at the
   *  root path (see scripts/inline-svgs.js) when it exists, so shipped
   *  pages get inline SVG icons instead of empty placeholders.  Falls
   *  back to `src/client/web/index.html` when the build hasn't run yet —
   *  the page still boots, only the ui-* icons render as empty spans. */
  const publicDir = path.resolve(__dirname, "client", "web");
  let relative;
  if (clean === "/") {
    const distIndex = path.resolve(publicDir, "dist", "index.html");
    relative = fs.existsSync(distIndex) ? "dist/index.html" : "index.html";
  } else {
    relative = clean.replace(/^\/public\//, "").replace(/^\//, "");
  }
  const filePath = path.resolve(publicDir, relative);

  // Security: reject paths that escape public dir
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, {
      "Content-Type": "text/plain",
    });
    res.end("403 Forbidden");
    return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME[ext] || "application/octet-stream";

  try {
    const data = fs.readFileSync(filePath);
    // HTML: no-cache so index.html (with cache-bust query) is always fresh.
    // JS/CSS/fonts: immutable-style caching (cache-bust query handles updates).
    const isHtml = ext === ".html";
    const headers = {
      "Content-Type": mimeType,
      "Content-Length": data.length,
      "Cache-Control": isHtml
        ? "no-cache, no-store, must-revalidate"
        : "public, max-age=31536000, immutable",
    };
    if (isHtml) {
      headers["Pragma"] = "no-cache";
      headers["Expires"] = "0";
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch (_) {
    res.writeHead(500, {
      "Content-Type": "text/plain",
    });
    res.end("500 Internal Server Error");
  }
  return true;
}

// ── JSON API helpers ────────────────────────────────

/**
 * Write a JSON response. Each BigInt in the body goes out as its decimal
 * text, every digit kept, since the format has none. A position's bot
 * state, which the status answer sends whole, keeps some, such as the
 * wallet's readings the deposit count compares. The rule is the one the
 * rebalance log is written by (src/lib/bigint-json.js).
 * @param {http.ServerResponse} res
 * @param {number}              status
 * @param {object}              body
 */
function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body, bigIntReplacer, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Read and parse the request body as JSON.
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (_) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── Route handlers (delegated to server-routes) ─────

const { createRouteHandlers } = require("./server/server-routes");
const { getLpProviderDisplayName } = require("./lib/lp-providers");
const { createApiStatusHandler } = require("./server/handle-api-status");
const { createPositionStateRoutes } = require("./server/position-state-routes");
const {
  createPositionRoutes,
  createPositionHistoryRoute,
  historyTokenId,
} = require("./server/position-routes");
const { moralisEnabledIn } = require("./lib/moralis-key");
const { askPassword: _askPassword } = require("./lib/ask-password");
const {
  notifyShutdown: _notifyShutdown,
} = require("./server/telegram-notifications/server-shutdown");

/*-
 *  Whether an unlock or the launch's key step is using the wallet: a
 *  Clear is refused meanwhile (src/server/wallet-clear.js).
 */
const _walletInUse = createWalletInUse();

const _routeHandlers = createRouteHandlers({
  bot: _bot,
  diskConfig: _diskConfig,
  walletManager,
  walletInUse: _walletInUse,
  jsonResponse,
  readJsonBody,
  askPassword: _headless ? _askPassword : null,
  notifyShutdown: _notifyShutdown,
});

// ── Idle-driven price-lookup pause ──────────────────
// Server-side tracker + the two pause/unpause endpoints.  See
// docs/architecture.md "Idle-Driven Price-Lookup Pause".

const _pauseInfra = createPauseInfra({ bot: _bot, jsonResponse, readJsonBody });

// ── Position routes, each answered by the bot ───────

const _positionRoutes = createPositionRoutes({
  bot: _bot,
  jsonResponse,
  readJsonBody,
});
const _positionHistory = createPositionHistoryRoute({
  bot: _bot,
  jsonResponse,
});

// ── Route table ─────────────────────────────────────

const _routes = {
  "GET /health": (_, res) =>
    jsonResponse(res, 200, {
      ok: true,
      port: config.PORT,
      ts: Date.now(),
    }),
  "GET /api/status": createApiStatusHandler({
    config,
    diskConfig: _diskConfig,
    walletManager,
    walletInUse: _walletInUse,
    bot: _bot,
    getLpProviderDisplayName,
    moralisEnabledIn,
    jsonResponse,
  }),
  "GET /api/wallet/status": (_, res) =>
    jsonResponse(res, 200, {
      ...walletManager.getStatus(),
      locked: walletManager.hasWallet() && !_bot.hasPrivateKey(),
    }),
  "POST /api/wallet/unlock": createUnlockHandler({
    walletManager,
    walletInUse: _walletInUse,
    bot: _bot,
    decryptApiKeys: (pw) => _routeHandlers._decryptApiKeys(pw),
    jsonResponse,
    readJsonBody,
  }),
  "DELETE /api/wallet": createWalletClearRoute({
    walletManager,
    walletInUse: _walletInUse,
    bot: _bot,
    jsonResponse,
  }),
  "POST /api/config": _routeHandlers._handleApiConfig,
  "POST /api/api-keys": _routeHandlers._handleApiKeySave,
  "GET /api/api-keys/status": _routeHandlers._handleApiKeyStatus,
  ...userConfigurableRoutes(jsonResponse),
  "POST /api/telegram/config": _routeHandlers._tgHandlers.handleTelegramConfig,
  "GET /api/telegram/config": _routeHandlers._tgHandlers.handleTelegramStatus,
  "POST /api/telegram/test": _routeHandlers._tgHandlers.handleTelegramTest,
  "POST /api/wallet": _routeHandlers._handleWalletImport,
  "POST /api/wallet/reveal": _routeHandlers._handleWalletReveal,
  "POST /api/stop-when-all-clear": (req, res) =>
    _routeHandlers._handleStopWhenAllClear(req, res, server),

  // ── Positions, each answered by the bot ───────
  ..._positionRoutes,
  ...createPositionStateRoutes({ bot: _bot, jsonResponse }),

  // ── Idle-driven price-lookup pause endpoints ──
  ..._pauseInfra.routes,
};

// ── Request router ──────────────────────────────────

/**
 * Main request handler.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 */
async function handleRequest(req, res) {
  const { method, url } = req;

  if (handleCors(req, res, _serverPort, jsonResponse)) return;
  if (handleCsrf(req, res, jsonResponse)) return;

  /*- Reset the server-side idle countdown on every /api/* request.
   *  Excludes /health (load-balancer probe).  Does NOT clear an
   *  existing pause flag — unpausing is always explicit (browser
   *  endpoint or move scope). */
  if (url.startsWith("/api/")) _pauseInfra.markActivity();

  // A route is named by its path; a handler reads its query string from req.url.
  const routeKey = method + " " + url.split("?")[0];
  const handler = _routes[routeKey];
  if (handler) {
    try {
      await handler(req, res);
    } catch (err) {
      const code = err.message === "Wrong password" ? 403 : 400;
      jsonResponse(res, code, {
        ok: false,
        error: err.message,
      });
    }
    return;
  }

  // ── Dynamic GET routes ────────────────────────
  const historyOf = historyTokenId(method, url);
  if (historyOf !== null) {
    await _positionHistory(historyOf, res);
    return;
  }

  if (method === "GET") {
    _serveStaticOrSpa(url, res);
    return;
  }

  // ── Catch-all ─────────────────────────────────
  res.writeHead(405, {
    "Content-Type": "text/plain",
  });
  res.end("405 Method Not Allowed");
}

/**
 * SPA catch-all for GET requests: serve the requested file from src/client/web/, or
 * fall back to index.html for extensionless paths (client-side routing), or
 * 404 for paths with file extensions that don't match a real file.
 * @param {string} url
 * @param {http.ServerResponse} res
 */
function _serveStaticOrSpa(url, res) {
  if (serveStatic(url, res)) return;
  const cleanPath = url.split("?")[0];
  if (!path.extname(cleanPath)) {
    serveStatic("/", res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not Found");
}

// ── Server lifecycle ────────────────────────────────

/** Actual listening port — updated in start() for test overrides. */
let _serverPort = config.PORT;

const server = http.createServer(handleRequest);
// Lifetime P&L scans can take 5+ minutes for old pools (555 paced chunks).
/*- `requestTimeout` is deliberately left at Node's own default.
 *
 *  It bounds how long a client may take to SEND a request — a
 *  slow-client guard against holding a connection open a byte at a
 *  time — and does NOT bound how long a handler may take to answer.
 *  Verified: a 3-second handler under a 1-second requestTimeout still
 *  returns its response intact.
 *
 *  It was previously raised to two hours "so lifetime P&L scans don't
 *  get cut off", which it cannot do. Raising it only weakened the
 *  guard. A scan that runs for hours is unaffected either way, so
 *  there is nothing here to tune. */

/**
 * Start the server on the configured port and host.
 * Logs the dashboard URL to stdout on success.
 * @param {number} [portOverride]
 *   Optional one-time port override (for tests).
 * @returns {Promise<http.Server>}
 */
function start(portOverride) {
  const port = portOverride !== undefined ? portOverride : config.PORT;
  _serverPort = port;
  const host = config.HOST;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const loopback = host === "0.0.0.0" || host === "127.0.0.1";
      const addr = `http://${loopback ? "localhost" : host}:${port}`;
      log.info(
        `[server] Blockchain:  ${config.CHAIN.displayName}` +
          ` (chainId ${config.CHAIN.chainId})`,
      );
      log.info(`[server] NFT Factory:` + ` ${config.POSITION_MANAGER}`);
      log.info(
        "[server] Wallet:     " +
          ` ${walletManager.getAddress() || "(not loaded)"}`,
      );
      log.info(`[server] Dashboard:   ${addr}`);
      log.info(`[server] API:         ${addr}/api/status`);
      log.info(
        "[server] Port:       " + ` ${port}  (change with PORT= in .env)`,
      );
      log.info(`[server] Health:      ${addr}/health`);
      resolve(server);
    });
  });
}

/**
 * Stop the server gracefully.
 * @returns {Promise<void>}
 */
function stop() {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ── Entry point ─────────────────────────────────────

// Only start automatically when run directly
// (`node src/server.js`).
// When required as a module (e.g. in tests), the
// caller controls lifecycle.
if (require.main === module) {
  installServerErrorGuard();
  // Read before anything starts, so an unusable value stops startup.
  const { exitTimeoutMs } = readShutdownTimings();
  start()
    .then(() => {
      /*-
       *  The server holds its port and has read no request: none is read
       *  before this chain first waits, and these three come first. A
       *  second start, which fails on the port, gets no further, so it
       *  changes none of these files under the server already running:
       *  - the previous run's error log is deleted, so no stale entry
       *    lingers; current problems are logged again by the scans
       *    (src/lib/error-log.js);
       *  - the wallet's files are put right: the copy a save cut short
       *    left is put back as wallet.json, or removed
       *    (src/lib/wallet-manager.js). Only the programs that own the
       *    wallet do this, as they start; a util tool that loads the
       *    module only reads;
       *  - the safety copies of bot-config.json and the records file are
       *    made, before anything has saved either (src/lib/bot-config-v2.js).
       */
      resetErrorLog();
      walletManager.settleWalletFile();
      backUpSettings();
      /*-
       *  Server is up: record the PID so `npm stop` (scripts/stop.js) can send
       *  SIGTERM for the same clean shutdown as Ctrl+C. The file is removed
       *  when this process exits, however it exits (src/server/server-pid.js).
       *
       *  Both come before the wallet key is resolved, not after it.
       *  Resolving it can wait on a terminal prompt, and then starts the
       *  managed positions one at a time, the first already running while
       *  the rest wait their turn. Until the handlers are in place, either
       *  signal ends the process on the spot, positions mid-start.
       */
      writePidFile();
      const shutdown = () => {
        _bot.markStopping();
        log.info("\n[server] Shutting down\u2026");
        _notifyShutdown();
        _pauseInfra.stop();
        _bot.stopAll().catch(() => {});
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), exitTimeoutMs);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .then(() => _routeHandlers._tryResolveKey())
    .catch((err) => {
      log.error("[server] Failed to start:", err.message);
      process.exit(1);
    });
}

module.exports = {
  start,
  stop,
  handleRequest,
  _diskConfig,
};
