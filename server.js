/**
 * @file server.js
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
 *   GET  /                          → public/index.html (dashboard)
 *   GET  /public/*                  → static files from public/
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
 *   GET  /api/position/:tokenId/history → Closed position historical P&L
 *
 *   UI
 *   GET  /api/ui-defaults           → Dashboard default preferences (sounds, etc.)
 *   GET  /api/nft-providers         → Short labels for NFT position-manager contracts
 *
 *   Actions
 *   POST /api/rebalance             → Force-rebalance a position (positionKey)
 *   POST /api/compound              → Force-compound fees on a position (positionKey)
 *   POST /api/shutdown              → Graceful shutdown (stops all positions + server)
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
 * node server.js              // → http://localhost:5555
 *
 * // start bot (requires PRIVATE_KEY):
 * node bot.js
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ROAD MAP
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * See README.md § Road Map for planned features.
 */

"use strict";

const { installColorLogger, emojiId } = require("./src/logger");
installColorLogger();

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  require("./src/cli-help")("server");
  process.exit(0);
}

const _headless = process.argv.includes("--headless");

const http = require("http");
const fs = require("fs");
const path = require("path");

const config = require("./src/config");
const { handleCors } = require("./src/server-cors");
const { handleCsrf } = require("./src/server-csrf");
const walletManager = require("./src/wallet-manager");
const { getPositionHistory } = require("./src/position-history");
const { createRebalanceLock } = require("./src/rebalance-lock");
const { createPositionManager } = require("./src/position-manager");
const botRecorder = require("./src/bot-recorder");
const { loadConfig, managedKeys } = require("./src/bot-config-v2");
const { migrateAppConfig } = require("./src/migrate-app-config");
const { buildGasStatusPayload } = require("./src/gas-monitor");
const { actualGasCostUsd } = require("./src/bot-pnl-updater");
const { staticTunablesRoutes } = require("./src/static-tunables-routes");
const _unlockLog = require("./src/server-unlock-log");
const { logVersionBanner } = require("./src/build-info");

/*-
 * First log: version/commit banner for support triage. Logged before
 * any other startup work so it is always at the top of the server log.
 */
logVersionBanner("[server]");

// ── app-config migration ─────────────────────────────
// One-time move of legacy root-level config files into app-config/.
// Idempotent: a no-op after the first successful run. See
// src/migrate-app-config.js and the app-config/ section of this file.
migrateAppConfig();

// ── Position manager (module-level) ─────────────────

const _rebalanceLock = createRebalanceLock();
const _positionMgr = createPositionManager({
  rebalanceLock: _rebalanceLock,
});

/*- Seed today's per-pool daily rebalance counts from the on-disk
 *  rebalance log so a restart mid-day does not silently reset the
 *  daily cap (which would otherwise allow MAX_REBALANCES_PER_DAY ×
 *  restart-count rebalances against the intended cap). */
const _seeded = _positionMgr.seedPoolDailyCounts(botRecorder.readLog());
if (_seeded > 0)
  console.log("[server] Seeded %d pool rebalance(s) for today's cap", _seeded);

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

/** Bot config loaded from disk. */
const _diskConfig = loadConfig();

const _managedAtStartup = managedKeys(_diskConfig);
if (_managedAtStartup.length > 0)
  console.log(
    "[server] Loaded bot config (%d managed positions)",
    _managedAtStartup.length,
  );
for (const [k, v] of Object.entries(_diskConfig.positions || {}))
  console.log(
    "[server] Config position %s: status=%s keys=%s",
    k.slice(-10),
    v.status || "MISSING",
    Object.keys(v).join(","),
  );

// ── Static file helper ──────────────────────────────

/**
 * Resolve a URL path to a file under `public/`,
 * read it, and write it to `res`.
 * Returns false if the file does not exist
 * (caller should 404).
 * @param {string}              urlPath
 * @param {http.ServerResponse} res
 * @returns {boolean}
 *   true if the file was found and served
 */
function serveStatic(urlPath, res) {
  // Normalise: strip query string, collapse '..'
  const clean = urlPath.split("?")[0];
  const relative =
    clean === "/"
      ? "index.html"
      : clean.replace(/^\/public\//, "").replace(/^\//, "");
  const filePath = path.resolve(__dirname, "public", relative);

  // Security: reject paths that escape public dir
  const publicDir = path.resolve(__dirname, "public");
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
 * Write a JSON response.
 * @param {http.ServerResponse} res
 * @param {number}              status
 * @param {object}              body
 */
function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
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

// ── Mutable private key ref ─────────────────────────

/**
 * Resolved private key — set once during bot start,
 * shared across all loops.  Passed by reference so
 * route handlers in server-routes.js can read/write.
 * @type {{ current: string|null }}
 */
const _privateKeyRef = { current: null };

// ── Route handlers (delegated to server-routes) ─────

const {
  getAllPositionBotStates,
  createPerPositionBotState,
  attachMultiPosDeps,
  buildStatusPositions,
  updatePositionState,
  createPositionRoutes,
} = require("./src/server-positions");

const { createRouteHandlers } = require("./src/server-routes");
const { askPassword: _askPassword } = require("./src/ask-password");

const _routeHandlers = createRouteHandlers({
  diskConfig: _diskConfig,
  positionMgr: _positionMgr,
  privateKeyRef: _privateKeyRef,
  walletManager,
  jsonResponse,
  readJsonBody,
  getAllPositionBotStates,
  createPerPositionBotState,
  attachMultiPosDeps,
  updatePositionState,
  askPassword: _headless ? _askPassword : null,
});

// ── Multi-position management routes ────────────────

const _positionRoutes = createPositionRoutes({
  diskConfig: _diskConfig,
  positionMgr: _positionMgr,
  walletManager,
  getPrivateKey: () => _privateKeyRef.current,
  jsonResponse,
  readJsonBody,
});

// ── Route table ─────────────────────────────────────

const _routes = {
  "GET /health": (_, res) =>
    jsonResponse(res, 200, {
      ok: true,
      port: config.PORT,
      ts: Date.now(),
    }),
  "GET /api/status": async (_, res) => {
    const posDefaults = {
      rebalanceOutOfRangeThresholdPercent: config.REBALANCE_OOR_THRESHOLD_PCT,
      rebalanceTimeoutMin: config.REBALANCE_TIMEOUT_MIN,
      slippagePct: config.SLIPPAGE_PCT,
      checkIntervalSec: config.CHECK_INTERVAL_SEC,
      minRebalanceIntervalMin: config.MIN_REBALANCE_INTERVAL_MIN,
      maxRebalancesPerDay: config.MAX_REBALANCES_PER_DAY,
      gasStrategy: "auto",
    };
    const positions = buildStatusPositions(
      _diskConfig,
      posDefaults,
      _positionMgr,
      config,
    );
    const gasStatus = await buildGasStatusPayload({
      positionCount: _positionMgr.runningCount(),
      toUsd: actualGasCostUsd,
    });
    jsonResponse(res, 200, {
      global: {
        walletAddress: walletManager.getAddress(),
        positionScan: _routeHandlers.getPositionScanStatus(),
        port: config.PORT,
        host: config.HOST,
        rpcUrl: config.RPC_URL,
        positionManager: config.POSITION_MANAGER,
        positionManagerName:
          config.CHAIN.contracts?.positionManager?.name || "",
        chainDisplayName: config.CHAIN.displayName || config.CHAIN_NAME,
        defaultSlippagePct: config.DEFAULT_SLIPPAGE_PCT,
        compoundMinFeeUsd: config.COMPOUND_MIN_FEE_USD,
        compoundDefaultThresholdUsd: config.COMPOUND_DEFAULT_THRESHOLD_USD,
        factory: config.FACTORY,
        scanTimeoutMs: config.SCAN_TIMEOUT_MS,
        ...posDefaults,
        ..._diskConfig.global,
        managedPositions: (() => {
          const r = _positionMgr.getAll();
          const rk = new Set(r.map((p) => p.key));
          return [
            ...r,
            ...managedKeys(_diskConfig)
              .filter((k) => !rk.has(k))
              .map((k) => ({
                key: k,
                tokenId: k.split("-").pop(),
                status: _diskConfig.positions[k]?.status || "running",
              })),
          ];
        })(),
        poolDailyCounts: _positionMgr.getPoolDailyCounts(),
        gasStatus,
      },
      positions,
    });
  },
  "GET /api/wallet/status": (_, res) =>
    jsonResponse(res, 200, {
      ...walletManager.getStatus(),
      locked: walletManager.hasWallet() && !_privateKeyRef.current,
    }),
  "POST /api/wallet/unlock": async (req, res) => {
    _unlockLog.logUnlockRequest(req);
    const body = await readJsonBody(req);
    if (!body.password) {
      _unlockLog.logUnlockMissing();
      return jsonResponse(res, 400, { ok: false, error: "Missing password" });
    }
    _unlockLog.logUnlockAttempt(String(body.password).length);
    try {
      _privateKeyRef.current = (
        await walletManager.revealWallet(body.password)
      ).privateKey;
      _unlockLog.logUnlockSuccess(req);
      const _pw = body.password;
      const _w = (t) => (e) => console.warn("[server] %s: %s", t, e.message);
      _routeHandlers._decryptApiKeys(_pw).catch(_w("API key decrypt failed"));
      _routeHandlers
        ._autoStartManagedPositions()
        .catch(_w("Auto-start failed"));
      jsonResponse(res, 200, { ok: true });
    } catch (_err) {
      _unlockLog.logUnlockFail(_err);
      jsonResponse(res, 401, { ok: false, error: "Wrong password" });
    }
  },
  "DELETE /api/wallet": (_, res) => {
    console.warn(
      "[server] DELETE /api/wallet received" + " — clearing wallet file",
    );
    walletManager.clearWallet();
    jsonResponse(res, 200, { ok: true });
  },
  "POST /api/config": _routeHandlers._handleApiConfig,
  "POST /api/api-keys": _routeHandlers._handleApiKeySave,
  "GET /api/api-keys/status": _routeHandlers._handleApiKeyStatus,
  ...staticTunablesRoutes(jsonResponse),
  "POST /api/telegram/config": _routeHandlers._tgHandlers.handleTelegramConfig,
  "GET /api/telegram/config": _routeHandlers._tgHandlers.handleTelegramStatus,
  "POST /api/telegram/test": _routeHandlers._tgHandlers.handleTelegramTest,
  "POST /api/wallet": _routeHandlers._handleWalletImport,
  "POST /api/wallet/reveal": _routeHandlers._handleWalletReveal,
  "POST /api/positions/scan": _routeHandlers._handlePositionsScan,
  "POST /api/positions/refresh": _routeHandlers._handlePositionsRefresh,
  "POST /api/rebalance": async (req, res) => {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      /* empty body OK */
    }
    if (!body.positionKey) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Missing positionKey",
      });
      return;
    }
    const state = getAllPositionBotStates().get(body.positionKey);
    if (!state || !state.running) {
      jsonResponse(res, 409, {
        ok: false,
        error: "Position not running or syncing",
      });
      return;
    }
    const tokenId = body.positionKey.split("-").pop();
    console.log(
      "[server] Manual rebalance for %s %s" + " (customRange=%s)",
      body.positionKey,
      emojiId(tokenId),
      body.customRangeWidthPct || "default",
    );
    state.forceRebalance = true;
    state.rebalanceInProgress = true;
    state.rebalancePaused = false;
    state.rebalanceError = null;
    if (body.customRangeWidthPct > 0)
      state.customRangeWidthPct = Number(body.customRangeWidthPct);
    jsonResponse(res, 200, {
      ok: true,
      message: "Rebalance requested",
    });
  },
  "POST /api/compound": async (req, res) => {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      /* empty body OK */
    }
    if (!body.positionKey) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Missing positionKey",
      });
      return;
    }
    const state = getAllPositionBotStates().get(body.positionKey);
    if (!state || !state.running) {
      jsonResponse(res, 409, {
        ok: false,
        error: "Position not running or syncing",
      });
      return;
    }
    const tokenId = body.positionKey.split("-").pop();
    console.log(
      "[server] Manual compound for %s %s",
      body.positionKey,
      emojiId(tokenId),
    );
    state.forceCompound = true;
    jsonResponse(res, 200, {
      ok: true,
      message: "Compound requested",
    });
  },
  "POST /api/position/details": _routeHandlers._handlePositionDetails,
  "POST /api/position/lifetime": _routeHandlers._handlePositionLifetime,
  "POST /api/position/scan-cancel": _routeHandlers._handlePositionScanCancel,
  "POST /api/shutdown": (req, res) =>
    _routeHandlers._handleShutdown(req, res, server),

  // ── Multi-position management ─────────────────
  ..._positionRoutes,
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

  const routeKey = method + " " + url;
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
  if (
    method === "GET" &&
    url.startsWith("/api/position/") &&
    url.endsWith("/history")
  ) {
    const tokenId = url.slice("/api/position/".length, -"/history".length);
    // Find position state matching this tokenId
    let posState = null;
    for (const [, s] of getAllPositionBotStates()) {
      if (s.activePosition && String(s.activePosition.tokenId) === tokenId) {
        posState = s;
        break;
      }
    }
    jsonResponse(
      res,
      200,
      await getPositionHistory(tokenId, {
        rebalanceEvents: posState?.rebalanceEvents,
        activePosition: posState?.activePosition,
      }),
    );
    return;
  }

  // ── Static files: / and /public/* ─────────────
  // SPA catch-all: extensionless GET paths serve
  // index.html (client-side routing)
  if (method === "GET") {
    const served = serveStatic(url, res);
    if (!served) {
      const cleanPath = url.split("?")[0];
      if (!path.extname(cleanPath)) {
        serveStatic("/", res);
      } else {
        res.writeHead(404, {
          "Content-Type": "text/plain",
        });
        res.end("404 Not Found");
      }
    }
    return;
  }

  // ── Catch-all ─────────────────────────────────
  res.writeHead(405, {
    "Content-Type": "text/plain",
  });
  res.end("405 Method Not Allowed");
}

// ── Server lifecycle ────────────────────────────────

/** Actual listening port — updated in start() for test overrides. */
let _serverPort = config.PORT;

const server = http.createServer(handleRequest);
// Lifetime P&L scans can take 5+ minutes for old pools (555 chunks × 250ms).
// Node 22's default requestTimeout is 300s — raise via config.
server.requestTimeout = config.SCAN_TIMEOUT_MS;

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
      console.log("[server] Blockchain:" + "  PulseChain (chainId 369)");
      console.log(`[server] NFT Factory:` + ` ${config.POSITION_MANAGER}`);
      console.log(
        "[server] Wallet:     " +
          ` ${walletManager.getAddress() || "(not loaded)"}`,
      );
      console.log(`[server] Dashboard:   ${addr}`);
      console.log(`[server] API:         ${addr}/api/status`);
      console.log(
        "[server] Port:       " + ` ${port}  (change with PORT= in .env)`,
      );
      console.log(`[server] Health:      ${addr}/health`);
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

const { notifyShutdown: _notifyShutdown } = require("./src/server-shutdown");

// ── Entry point ─────────────────────────────────────

// Only start automatically when run directly
// (`node server.js`).
// When required as a module (e.g. in tests), the
// caller controls lifecycle.
if (require.main === module) {
  require("./src/server-error-guard")();
  start()
    .then(() => _routeHandlers._tryResolveKey())
    .then(() => {
      const shutdown = () => {
        console.log("\n[server] Shutting down\u2026");
        _notifyShutdown();
        _positionMgr.stopAll().catch(() => {});
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("[server] Failed to start:", err.message);
      process.exit(1);
    });
}

module.exports = {
  start,
  stop,
  handleRequest,
  _diskConfig,
  _positionMgr,
};
