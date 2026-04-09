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
 * This is the primary configuration reference for the project.  All environment
 * variables, contract addresses, and pricing API setup are documented here.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * QUICK START
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   1. Copy `.env.example` to `.env` and fill in your values.
 *   2. `npm install`
 *   3. `npm start`          — dashboard + bot (if wallet key available)
 *   4. `npm run bot`        — headless bot only (no dashboard)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * COMMAND-LINE FLAGS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   --verbose, -v   Enable verbose logging.  Shows per-cycle fee details and
 *                   out-of-range poll diagnostics that are hidden by default.
 *                   Can also be set via VERBOSE=1 in .env or environment.
 *
 *   --help, -h      Show all command-line options and exit.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENVIRONMENT VARIABLES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Server
 * ──────
 *   PORT                    HTTP port (default: 5555)
 *   HOST                    Bind address (default: '0.0.0.0')
 *
 * Chain
 * ─────
 *   CHAIN_NAME              Blockchain to connect to (default: 'pulsechain').
 *                           Set to 'pulsechain-testnet' for PulseChain Testnet v4.
 *                           Chain config (RPC URLs, contract addresses, gas
 *                           multipliers) is loaded from config/chains.json.
 *
 * Wallet (required for bot)
 * ─────────────────────────
 *   PRIVATE_KEY             Hex private key (0x-prefixed)
 *
 * Position Discovery
 * ──────────────────
 *   POSITION_ID             NFT token ID to manage (leave blank for auto-scan)
 *   ERC20_POSITION_ADDRESS  ERC-20 position token address (blank for NFT-only)
 *
 * Bot Behaviour
 * ─────────────
 *   RPC_URL                 JSON-RPC endpoint (default: https://rpc-pulsechain.g4mm4.io)
 *   RPC_URL_FALLBACK        Fallback RPC (default: https://rpc.pulsechain.com)
 *   REBALANCE_OOR_THRESHOLD_PCT  % beyond boundary to trigger rebalance (default: 10)
 *   REBALANCE_TIMEOUT_MIN   Minutes of continuous OOR before auto-rebalance (default: 180, 0=disabled)
 *   SLIPPAGE_PCT            Max slippage for txns (default: 0.5)
 *   TX_SPEEDUP_SEC          Seconds before a pending TX is speed-up-replaced (default: 120)
 *   TX_CANCEL_SEC           Seconds before a stuck TX is cancelled via 0-PLS self-transfer (default: 1200 = 20 min)
 *   CHECK_INTERVAL_SEC      Poll interval (default: 60)
 *   MIN_REBALANCE_INTERVAL_MIN   Min wait between rebalances (default: 10)
 *   MAX_REBALANCES_PER_DAY  Hard daily cap (default: 20)
 *   LOG_FILE                JSON log path (default: ./rebalance_log.json)
 *
 * Contract Addresses (9mm Pro V3 on PulseChain)
 * ──────────────────────────────────────────────
 *   Source: https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json
 *   POSITION_MANAGER        NonfungiblePositionManager (default: 0xCC05bf…)
 *   FACTORY                 V3 Factory (default: 0xe50Dbd…)
 *   SWAP_ROUTER             V3 SwapRouter (default: 0x7bE8fb…)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * USD PRICING — DexScreener
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Token prices (for P&L display) are resolved via:
 *
 *   **DexScreener** — no API key needed.
 *      Endpoint: GET https://api.dexscreener.com/latest/dex/tokens/{address}
 *      Filters to `chainId === 'pulsechain'` and picks the highest-liquidity pair.
 *      Works for any actively traded pair on PulseChain.
 *
 * Prices are cached in-memory for 60 seconds to reduce API calls.
 * See src/price-fetcher.js for implementation details.
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
 *   GET  /api/position/:tokenId/history → Closed position historical P&L
 *
 *   Actions
 *   POST /api/rebalance             → Force-rebalance a position (positionKey)
 *   POST /api/compound              → Force-compound fees on a position (positionKey)
 *   POST /api/shutdown              → Graceful shutdown (stops all positions + server)
 *
 *   Full OpenAPI 3.0 spec: docs/openapi.json
 *   Interactive docs:      npm run swagger → http://localhost:5556
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLIENT-SIDE URL ROUTING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The dashboard uses Navigo (pushState-based router, ~5KB) for bookmarkable,
 * shareable URLs that reflect the active wallet and position.
 *
 * URL structure
 * ─────────────
 *   /                                          Root (no state)
 *   /pulsechain/:wallet                        Wallet loaded, no position selected
 *   /pulsechain/:wallet/:contract/:tokenId     Specific NFT position deep-link
 *
 * Example: /pulsechain/0xabc123.../0xCC05bf.../157149
 *
 * SPA catch-all
 * ─────────────
 * The server serves index.html for any extensionless GET path that doesn't
 * match a known API route or static file.  Paths with file extensions (e.g.
 * .js, .css, .woff2) that don't match a real file return 404.  This allows
 * Navigo to handle routing on the client side after page load.
 *
 * Deep-link resolution flow
 * ─────────────────────────
 *   1. Navigo parses wallet, contract, tokenId from the URL path.
 *   2. If the wallet matches the loaded wallet → search posStore for the
 *      tokenId → activate if found.
 *   3. If the wallet is not yet loaded → store as a pending route target,
 *      resolved after wallet import or server restore.
 *   4. If the position is not in the store → trigger scanPositions() and
 *      retry lookup (up to 3 retries at 2-second intervals).
 *
 * URL updates
 * ───────────
 * When the user selects a position or imports/clears a wallet, the URL bar
 * is updated via router.navigate() with callHandler: false (no page reload,
 * no re-triggering of route handlers).  Addresses are lowercased in URLs.
 *
 * Source: public/dashboard-router.js
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEVELOPMENT TOOLS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * All dev tools are available via npm scripts — no npx needed.
 *
 * Build & Run
 * ───────────
 *   npm run build          esbuild bundle + cache-bust stamp (bundle.js?v=<ms>)
 *   npm start              Start server only (no build — use after `npm run build`)
 *   npm run build-and-start  Build + start in one command (replaces old `npm start`)
 *   npm run dev            Build + start with --watch (auto-restart on file changes)
 *
 * Lint & Test
 * ───────────
 *   npm run lint          ESLint — 0 warnings, complexity ≤17, max-lines ≤500
 *   npm run lint:fix      ESLint auto-fix
 *   npm test              Node.js built-in test runner (node:test)
 *   npm run test:coverage Test coverage report (Node 20+, --experimental-test-coverage)
 *   npm run test:watch    Re-run tests on file changes
 *   npm run check         Combined lint + test + 80% coverage gate (matches CI)
 *
 * CAUTION: `npm run check` (and `npm test`) actively write to config and cache
 * files during test execution.  Those files are backed up before the tests start
 * and restored automatically when the process exits.  However, if you Ctrl-C the
 * process mid-run, the restore may not complete and the files will be left in a
 * state that is only appropriate for the automated tests (stub position keys,
 * missing managed positions, etc.).  Always let tests and checks finish before
 * interrupting.  If you do fall into this problem, run `npm run clean` — the app
 * will run full-length blockchain wallet scans on next start to rebuild caches.
 *
 * Wallet Management
 * ─────────────────
 *   npm run reset-wallet  Delete .wallet.json + clear WALLET_PASSWORD from .env.
 *                         Forces a fresh wallet import via the dashboard on next start.
 *   npm run clean         reset-wallet + delete .bot-config.json, .epoch-cache.json,
 *                         rebalance_log.json, and tmp/event-cache.json.  Full state
 *                         reset.  Note: browser localStorage is NOT cleared by this
 *                         command — use the Settings gear icon → "Clear Local Storage
 *                         & Cookies" in the dashboard, or open DevTools → Application
 *                         → Local Storage → Clear All.
 *   npm run dev-clean     Same as clean but preserves the historical price cache
 *                         (tmp/historical-price-cache.json) for faster restart during
 *                         development.  Avoids re-fetching GeckoTerminal OHLCV data.
 *
 * Housekeeping
 * ────────────
 *   npm run nuke             Delete node_modules + package-lock.json for a clean
 *                            reinstall.  Run `npm install` afterwards.
 *   npm run wipe-settings    Back up all user settings/state (.env, .wallet.json,
 *                            .bot-config.json, .epoch-cache.json, rebalance_log.json,
 *                            tmp/event-cache.json, *.keyfile.json) to tmp/.settings-backup/
 *                            and remove them — simulates a fresh install.  Also clear
 *                            browser localStorage via Settings gear → "Clear Local
 *                            Storage & Cookies" to complete the simulation.
 *   npm run restore-settings Restore settings previously backed up by wipe-settings.
 *
 * API Documentation
 * ─────────────────
 *   npm run swagger       Start Swagger UI at http://localhost:5556 — interactive
 *                         API docs from docs/openapi.json (OpenAPI 3.0 spec).
 *
 * Dead Code Detection
 * ───────────────────
 *   npm run knip          Knip — finds unused exports, files, and dependencies.
 *                         Note: the 8 public/dashboard-*.js files are false
 *                         positives because knip cannot trace HTML <script> tags.
 *
 * Debugging
 * ─────────
 *   Server logs are printed to the terminal (stdout/stderr) with bracketed
 *   prefixes like [bot], [server], [rebalance], [compound], [event-scanner].
 *   Use --verbose (-v) for additional per-cycle detail.
 *
 *   Browser console logs use the [lp-ranger] prefix with a colored log-type
 *   signifier, e.g. [lp-ranger] [scan], [lp-ranger] [unmanaged].  High-
 *   frequency per-poll-cycle logs ([poll], [update], [skip], [deposit]) use
 *   console.debug and are hidden by default in Chrome DevTools.  To see them,
 *   open DevTools → Console → click the log-level dropdown (defaults to
 *   "Default levels") and enable "Verbose".
 *
 * DevDependencies
 * ───────────────
 *   eslint (v10)          Linter — flat config in eslint.config.js
 *   @eslint/js            ESLint recommended rules
 *   globals               Browser/Node global variable definitions for ESLint
 *   swagger-ui-dist       Swagger UI static assets for API documentation
 *   knip (v5)             Dead code / unused export detector
 *
 * @example
 * // .env
 * PORT=5555
 * HOST=0.0.0.0
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

const http = require("http");
const fs = require("fs");
const path = require("path");

const config = require("./src/config");
const walletManager = require("./src/wallet-manager");
const { getPositionHistory } = require("./src/position-history");
const { createRebalanceLock } = require("./src/rebalance-lock");
const { createPositionManager } = require("./src/position-manager");
const { loadConfig, managedKeys } = require("./src/bot-config-v2");

// ── Position manager (module-level) ─────────────────

const _rebalanceLock = createRebalanceLock();
const _positionMgr = createPositionManager({
  rebalanceLock: _rebalanceLock,
});

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
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Content-Length": data.length,
    });
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
  updatePositionState,
  createPositionRoutes,
} = require("./src/server-positions");

const { createRouteHandlers } = require("./src/server-routes");

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
  "GET /api/status": (_, res) => {
    const positions = {};
    const posDefaults = {
      rebalanceOutOfRangeThresholdPercent: config.REBALANCE_OOR_THRESHOLD_PCT,
      rebalanceTimeoutMin: config.REBALANCE_TIMEOUT_MIN,
      slippagePct: config.SLIPPAGE_PCT,
      checkIntervalSec: config.CHECK_INTERVAL_SEC,
      minRebalanceIntervalMin: config.MIN_REBALANCE_INTERVAL_MIN,
      maxRebalancesPerDay: config.MAX_REBALANCES_PER_DAY,
      gasStrategy: "auto",
    };
    for (const [key, state] of getAllPositionBotStates()) {
      const posConfig = _diskConfig.positions[key] || {};
      positions[key] = {
        ...posDefaults,
        ...state,
        ...posConfig,
      };
    }
    // Include lightweight config for unmanaged
    // positions so the dashboard gets settings
    const _SETTINGS_KEYS = [
      "rebalanceOutOfRangeThresholdPercent",
      "rebalanceTimeoutMin",
      "slippagePct",
      "checkIntervalSec",
      "minRebalanceIntervalMin",
      "maxRebalancesPerDay",
      "gasStrategy",
      "priceOverride0",
      "priceOverride1",
      "priceOverrideForce",
      "autoCompoundEnabled",
      "autoCompoundThresholdUsd",
      "totalCompoundedUsd",
      "lastCompoundAt",
    ];
    for (const [key, posConfig] of Object.entries(_diskConfig.positions)) {
      if (!positions[key]) {
        const s = { ...posDefaults };
        for (const k of _SETTINGS_KEYS)
          if (posConfig[k] !== undefined) s[k] = posConfig[k];
        positions[key] = s;
      }
    }
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
    const body = await readJsonBody(req);
    if (!body.password)
      return jsonResponse(res, 400, {
        ok: false,
        error: "Missing password",
      });
    try {
      _privateKeyRef.current = (
        await walletManager.revealWallet(body.password)
      ).privateKey;
      console.log("[server] Wallet unlocked via dashboard");
      _routeHandlers
        ._decryptApiKeys(body.password)
        .catch((e) =>
          console.warn("[server] API key decrypt failed:", e.message),
        );
      _routeHandlers
        ._autoStartManagedPositions()
        .catch((e) =>
          console.warn(
            "[server] Auto-start after unlock" + " failed:",
            e.message,
          ),
        );
      jsonResponse(res, 200, { ok: true });
    } catch (_err) {
      jsonResponse(res, 401, {
        ok: false,
        error: "Wrong password",
      });
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

  // CORS headers for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

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
  const host = config.HOST;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
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

// ── Entry point ─────────────────────────────────────

// Only start automatically when run directly
// (`node server.js`).
// When required as a module (e.g. in tests), the
// caller controls lifecycle.
if (require.main === module) {
  start()
    .then(() => _routeHandlers._tryResolveKey())
    .then(() => {
      const shutdown = () => {
        console.log("\n[server] Shutting down\u2026");
        _positionMgr.stopAll().catch(() => {});
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // Diagnostic: log config state at exit to catch position-loss bugs
      process.on("exit", () => {
        const pk = Object.keys(_diskConfig.positions || {});
        const r = pk.filter(
          (k) => _diskConfig.positions[k]?.status === "running",
        ).length;
        console.log(
          "[server] exit: %d positions in memory (%d running)",
          pk.length,
          r,
        );
      });
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
