/**
 * @file server.js
 * @description
 * HTTP server and main entry point for the 9mm v3 Position Manager dashboard.
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
 * ENVIRONMENT VARIABLES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Server
 * ──────
 *   PORT                    HTTP port (default: 5555)
 *   HOST                    Bind address (default: '0.0.0.0')
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
 * USD PRICING — DexScreener + DexTools
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Token prices (for P&L display) are resolved in this order:
 *
 *   1. **DexScreener** (primary) — no API key needed.
 *      Endpoint: GET https://api.dexscreener.com/latest/dex/tokens/{address}
 *      Filters to `chainId === 'pulsechain'` and picks the highest-liquidity pair.
 *      Works for any actively traded pair on PulseChain.
 *
 *   2. **DexTools** (fallback) — requires an API key.
 *      Endpoint: GET https://public-api.dextools.io/free/v2/token/{chain}/{address}/price
 *      Only queried when DexScreener returns no result AND an API key is configured.
 *
 * How to configure DexTools:
 * ─────────────────────────
 *   1. Sign up at https://developer.dextools.io
 *   2. Create a free API key under your dashboard
 *   3. Add to .env:   DEXTOOLS_API_KEY=your-key-here
 *   4. Restart the bot.  The fallback activates automatically.
 *
 * Leave DEXTOOLS_API_KEY blank (the default) to use DexScreener only — it
 * covers the vast majority of PulseChain pairs without any key.
 *
 * Prices are cached in-memory for 60 seconds to reduce API calls.
 * See src/price-fetcher.js for implementation details.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ROUTES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   GET  /              → public/index.html (dashboard)
 *   GET  /public/*      → static files from public/
 *   GET  /api/status    → JSON snapshot of bot + position state
 *   POST /api/config    → Update runtime config (throttle params, etc.)
 *   POST /api/position/switch → Switch bot to a different NFT position
 *   POST /api/shutdown  → Graceful shutdown (stops bot + server)
 *   GET  /health        → 200 OK (used by load-balancers / pm2)
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
 *
 * Dead Code Detection
 * ───────────────────
 *   npm run knip          Knip — finds unused exports, files, and dependencies.
 *                         Note: the 8 public/dashboard-*.js files are false
 *                         positives because knip cannot trace HTML <script> tags.
 *
 * DevDependencies
 * ───────────────
 *   eslint (v10)          Linter — flat config in eslint.config.js
 *   @eslint/js            ESLint recommended rules
 *   globals               Browser/Node global variable definitions for ESLint
 *   knip (v5)             Dead code / unused export detector
 *
 * @example
 * // .env
 * PORT=5555
 * HOST=0.0.0.0
 * DEXTOOLS_API_KEY=           # leave blank for DexScreener-only
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

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const config = require('./src/config');
const walletManager = require('./src/wallet-manager');
const { detectPositionType } = require('./src/position-detector');
const { startBotLoop, resolvePrivateKey } = require('./src/bot-loop');
const { getPositionHistory } = require('./src/position-history');

// ── Bot handle (module-level) ────────────────────────────────────────────────

/** @type {{ stop: Function }|null} Active bot loop handle, or null if not running. */
let _botHandle = null;

// ── MIME type map ─────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
};

// ── Bot config persistence ───────────────────────────────────────────────

const _BOT_CONFIG_PATH = path.join(process.cwd(), '.bot-config.json');

/** Keys that are persisted across sessions. */
const _PERSISTED_KEYS = [
  'rebalanceOutOfRangeThresholdPercent', 'rebalanceTimeoutMin',
  'slippagePct', 'checkIntervalSec',
  'minRebalanceIntervalMin', 'maxRebalancesPerDay',
  'gasStrategy', 'triggerType',
  'initialDepositUsd', 'hodlBaseline', 'residuals', 'pnlEpochs',
  'activePositionId', 'collectedFeesUsd',
];

/**
 * Load persisted bot config from disk and merge into target object.
 * @param {object} target  Object to merge saved values into.
 */
function _loadBotConfig(target) {
  try {
    const raw = fs.readFileSync(_BOT_CONFIG_PATH, 'utf8');
    const saved = JSON.parse(raw);
    for (const key of _PERSISTED_KEYS) {
      if (saved[key] !== undefined) target[key] = saved[key];
    }
    console.log('[server] Loaded saved bot config from .bot-config.json');
  } catch { /* no saved config yet */ }
}

/**
 * Save the current bot config values to disk.
 * @param {object} source  Object containing current values.
 */
function _saveBotConfig(source) {
  const data = {};
  for (const key of _PERSISTED_KEYS) {
    if (source[key] !== undefined) data[key] = source[key];
  }
  try {
    fs.writeFileSync(_BOT_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[server] Could not save bot config:', err.message);
  }
}

// ── In-memory state written by bot.js, read by /api/status ───────────────────

/** @type {object} Mutable shared state updated by the bot process. */
const botState = {
  running:    false,
  startedAt:  null,
  port:       config.PORT,
  host:       config.HOST,
  rpcUrl:     config.RPC_URL,
  rebalanceOutOfRangeThresholdPercent: config.REBALANCE_OOR_THRESHOLD_PCT,
  rebalanceTimeoutMin:    config.REBALANCE_TIMEOUT_MIN,
  slippagePct:            config.SLIPPAGE_PCT,
  checkIntervalSec:       config.CHECK_INTERVAL_SEC,
  minRebalanceIntervalMin: config.MIN_REBALANCE_INTERVAL_MIN,
  maxRebalancesPerDay:    config.MAX_REBALANCES_PER_DAY,
  gasStrategy:            'auto',
  triggerType:            'oor',
  positionManager:        config.POSITION_MANAGER,
  factory:                config.FACTORY,
  activePosition:         null,
  rebalanceCount:         0,
  lastRebalanceAt:        null,
  rebalanceError:         null,
  rebalancePaused:        false,
  rebalanceScanComplete:  false,
  rebalanceScanProgress:  0,
  updatedAt:              null,
};

// Load saved bot config from disk (overrides defaults above)
_loadBotConfig(botState);

/**
 * Update the shared bot state.  Called by bot.js when it starts or rebalances.
 * @param {Partial<typeof botState>} patch
 */
function updateBotState(patch) {
  // Persist pnlEpochs on first creation (so openTime survives restarts)
  if (patch.pnlEpochs && !botState.pnlEpochs) {
    Object.assign(botState, patch);
    _saveBotConfig(botState);
  }
  // Persist HODL baseline on first detection (for IL calculation)
  if (patch.pnlSnapshot?._setHodlBaseline && !botState.hodlBaseline) {
    botState.hodlBaseline = patch.pnlSnapshot._setHodlBaseline;
    delete patch.pnlSnapshot._setHodlBaseline;
    _saveBotConfig(botState);
  }
  // Persist HODL baseline from historical price lookup
  if (patch.hodlBaseline) {
    _saveBotConfig({ ...botState, ...patch });
  }
  // Merge positionMintDate into hodlBaseline
  if (patch.positionMintDate && botState.hodlBaseline) {
    botState.hodlBaseline.mintDate = patch.positionMintDate;
    _saveBotConfig(botState);
    delete patch.positionMintDate;
  }
  // Persist activePositionId when it changes (e.g. after rebalance mints new NFT)
  if (patch.activePositionId && patch.activePositionId !== botState.activePositionId) {
    console.log('[server] activePositionId changing: %s → %s', botState.activePositionId, patch.activePositionId);
    Object.assign(botState, patch);
    _saveBotConfig(botState);
  }
  const hadBaseline = !!botState.hodlBaseline;
  Object.assign(botState, patch, { updatedAt: new Date().toISOString() });
  if (hadBaseline && !botState.hodlBaseline) {
    console.warn('[server] hodlBaseline CLEARED by patch with keys:', Object.keys(patch).join(', '));
  }
  // Execute queued position switch after bot stops (e.g. rebalance finished)
  if (patch.running === false && botState.pendingSwitch) {
    const tid = botState.pendingSwitch;
    console.log('[server] Executing queued switch to #%s', tid);
    _botHandle = null;
    _executePositionSwitch(tid, null);
  }
}

// ── Static file helper ────────────────────────────────────────────────────────

/**
 * Resolve a URL path to a file under `public/`, read it, and write it to `res`.
 * Returns false if the file does not exist (caller should 404).
 * @param {string}                       urlPath
 * @param {http.ServerResponse}          res
 * @returns {boolean}  true if the file was found and served
 */
function serveStatic(urlPath, res) {
  // Normalise: strip query string, collapse '..' traversal
  const clean    = urlPath.split('?')[0];
  const relative = clean === '/' ? 'index.html' : clean.replace(/^\/public\//, '').replace(/^\//, '');
  const filePath = path.resolve(__dirname, 'public', relative);

  // Security: reject paths that escape the public directory
  const publicDir = path.resolve(__dirname, 'public');
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': data.length });
    res.end(data);
  } catch (_) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('500 Internal Server Error');
  }
  return true;
}

// ── JSON API helpers ──────────────────────────────────────────────────────────

/**
 * Write a JSON response.
 * @param {http.ServerResponse} res
 * @param {number}              status
 * @param {object}              body
 */
function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type':  'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
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
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  ()    => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function _handleApiConfig(req, res) {
  const body = await readJsonBody(req);
  const allowed = [
    'rebalanceOutOfRangeThresholdPercent', 'rebalanceTimeoutMin',
    'slippagePct', 'checkIntervalSec',
    'minRebalanceIntervalMin', 'maxRebalancesPerDay',
    'gasStrategy', 'triggerType',
    'initialDepositUsd',
  ];
  const patch = {};
  for (const key of allowed) { if (body[key] !== undefined) patch[key] = body[key]; }
  updateBotState(patch); _saveBotConfig(botState);
  jsonResponse(res, 200, { ok: true, applied: patch });
}

async function _handleWalletImport(req, res) {
  const body = await readJsonBody(req);
  console.log('[server] Wallet import requested for %s (bot running: %s)', body.address?.slice(0, 10), !!_botHandle);
  await walletManager.importWallet({
    address: body.address, privateKey: body.privateKey,
    mnemonic: body.mnemonic || null, source: body.source || 'key',
    password: body.password,
  });

  // Persist WALLET_PASSWORD to .env so the bot auto-starts on restart
  _persistWalletPassword(body.password);

  // Stop the running bot (if any) and clear position-specific state so the
  // dashboard doesn't display stale data from the previous wallet.
  if (_botHandle) { await _botHandle.stop(); _botHandle = null; }
  Object.assign(botState, { activePosition: null, activePositionId: undefined,
    rebalanceCount: 0, lastRebalanceAt: null, rebalanceError: null, rebalancePaused: false,
    rebalanceScanComplete: false, rebalanceEvents: undefined,
    pnlEpochs: undefined, hodlBaseline: undefined, residuals: undefined });
  _saveBotConfig(botState);
  jsonResponse(res, 200, { ok: true, address: body.address });

  // Auto-start bot with the new wallet
  _tryStartBot(body.password).catch(err => {
    console.warn('[server] Auto-start bot after import failed:', err.message);
  });
}

/**
 * Persist the wallet password to the .env file so the bot can auto-start
 * on future restarts without requiring manual password entry.
 * @param {string} password  The wallet encryption password.
 */
function _persistWalletPassword(password) {
  const envPath = path.join(process.cwd(), '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch { /* no file yet */ }
    // Quote the password to handle special characters
    const escaped = password.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const line = 'WALLET_PASSWORD="' + escaped + '"';
    if (content.includes('WALLET_PASSWORD=')) {
      content = content.replace(/^WALLET_PASSWORD=.*$/m, line);
    } else {
      content += (content && !content.endsWith('\n') ? '\n' : '') + line + '\n';
    }
    fs.writeFileSync(envPath, content, 'utf8');
    console.log('[server] WALLET_PASSWORD persisted to .env for auto-start on restart');
  } catch (err) {
    console.warn('[server] Could not persist WALLET_PASSWORD to .env:', err.message);
  }
}

/**
 * Attempt to start the bot loop.  Used at startup and after wallet import.
 * @param {string|null} [password]  Password override for wallet decryption.
 * @returns {Promise<void>}
 */
let _botStarting = false;
async function _tryStartBot(password) {
  if (_botStarting) { console.log('[server] Bot start already in progress — skipping'); return; }
  _botStarting = true;
  // Temporarily override WALLET_PASSWORD if a password was provided
  const origWalletPw = config.WALLET_PASSWORD;
  if (password && !config.WALLET_PASSWORD) {
    config.WALLET_PASSWORD = password;
  }
  try {
    const privateKey = await resolvePrivateKey({ askPassword: null });
    if (!privateKey) {
      console.log('[server] No wallet key — dashboard-only mode. Import a wallet via the dashboard to start the bot.');
      return;
    }
    if (_botHandle) { await _botHandle.stop(); _botHandle = null; }
    console.log('[server] Starting bot with activePositionId=%s', botState.activePositionId || 'none (will auto-detect)');
    _botHandle = await startBotLoop({
      privateKey,
      dryRun: config.DRY_RUN,
      updateBotState,
      botState,
      positionId: botState.activePositionId || undefined,
    });
    console.log('[server] Bot started');
  } finally {
    config.WALLET_PASSWORD = origWalletPw;
    _botStarting = false;
  }
}

async function _handleWalletReveal(req, res) {
  const body    = await readJsonBody(req);
  const secrets = await walletManager.revealWallet(body.password);
  jsonResponse(res, 200, {
    ok: true, address: walletManager.getAddress(),
    privateKey: secrets.privateKey, mnemonic: secrets.mnemonic,
    hasMnemonic: !!secrets.mnemonic, source: walletManager.getStatus().source,
  });
}

/**
 * Resolve the on-chain symbol for a token address.
 * Returns the address truncated if the call fails.
 * @param {object} provider  ethers provider.
 * @param {string} address   Token contract address.
 * @returns {Promise<string>}
 */
async function _resolveTokenSymbol(provider, address) {
  if (!address) return '?';
  try {
    const ethersLib = require('ethers');
    const abi = [
      'function symbol() view returns (string)',
      'function name() view returns (string)',
    ];
    const c = new ethersLib.Contract(address, abi, provider);
    const name = await c.name().catch(() => null);
    if (name) return name;
    const symbol = await c.symbol().catch(() => null);
    return symbol || address.slice(0, 6) + '\u2026' + address.slice(-4);
  } catch {
    return address.slice(0, 6) + '\u2026' + address.slice(-4);
  }
}

async function _handlePositionsScan(req, res) {
  const wStatus = walletManager.getStatus();
  if (!wStatus.loaded) {
    jsonResponse(res, 400, { ok: false, error: 'No wallet loaded. Import a wallet first.' });
    return;
  }
  const body     = await readJsonBody(req);
  const rpcUrl   = body.rpcUrl || config.RPC_URL;
  const pmAddr   = body.positionManagerAddress || config.POSITION_MANAGER;
  const ethers   = require('ethers');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const result   = await detectPositionType(provider, {
    walletAddress: wStatus.address, positionManagerAddress: pmAddr,
    candidateAddress: body.erc20Address || undefined,
  });

  // Resolve token symbols for all unique addresses
  const addrSet = new Set();
  for (const p of (result.nftPositions || [])) { addrSet.add(p.token0); addrSet.add(p.token1); }
  for (const p of (result.erc20Positions || [])) { if (p.token0) addrSet.add(p.token0); if (p.token1) addrSet.add(p.token1); }
  const symbolMap = {};
  await Promise.all([...addrSet].map(async (addr) => {
    symbolMap[addr] = await _resolveTokenSymbol(provider, addr);
  }));

  jsonResponse(res, 200, {
    ok: true, type: result.type, positionManagerAddress: pmAddr,
    nftPositions: (result.nftPositions || []).map(p => ({
      ...p, tokenId: String(p.tokenId), liquidity: String(p.liquidity),
      token0Symbol: symbolMap[p.token0] || '?', token1Symbol: symbolMap[p.token1] || '?',
    })),
    erc20Positions: (result.erc20Positions || []).map(p => ({
      ...p,
      token0Symbol: p.token0 ? (symbolMap[p.token0] || '?') : '?',
      token1Symbol: p.token1 ? (symbolMap[p.token1] || '?') : '?',
    })),
  });
}

/**
 * Switch the bot to a different NFT position.
 * Stops the current bot loop, clears position-specific state, and restarts.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 */
async function _handlePositionSwitch(req, res) {
  const body = await readJsonBody(req);
  console.log('[server] Position switch requested: tokenId=%s (current=%s)', body.tokenId, botState.activePositionId);
  if (!body.tokenId) {
    jsonResponse(res, 400, { ok: false, error: 'Missing tokenId' });
    return;
  }
  const cur = botState.activePositionId || botState.activePosition?.tokenId;
  if (cur && String(cur) === String(body.tokenId)) {
    console.log('[server] Already on #%s — skipping switch', body.tokenId);
    jsonResponse(res, 200, { ok: true, tokenId: String(body.tokenId), alreadyActive: true });
    return;
  }
  // Queue the switch if a rebalance is in progress — don't kill the bot mid-transaction
  if (botState.rebalanceInProgress) {
    botState.pendingSwitch = String(body.tokenId);
    console.log('[server] Rebalance in progress — queued switch to #%s', body.tokenId);
    jsonResponse(res, 202, { ok: true, tokenId: String(body.tokenId), queued: true });
    return;
  }
  _executePositionSwitch(String(body.tokenId), res);
}

/** Execute a position switch immediately: stop bot, clear state, restart. */
function _executePositionSwitch(tokenId, res) {
  try {
    if (_botHandle) { _botHandle.stop().then(() => { _botHandle = null; }); _botHandle = null; }
    Object.assign(botState, { pnlEpochs: undefined, hodlBaseline: undefined, residuals: undefined,
      rebalanceScanComplete: false, rebalanceEvents: undefined, activePosition: null,
      rebalanceCount: 0, lastRebalanceAt: null, rebalanceError: null, rebalancePaused: false,
      pendingSwitch: undefined });
    botState.activePositionId = tokenId;
    _saveBotConfig(botState);
    _tryStartBot(null).catch(err => {
      console.warn('[server] Bot restart after position switch failed:', err.message);
    });
    if (res) jsonResponse(res, 200, { ok: true, tokenId });
  } catch (err) {
    if (res) jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

async function _handleShutdown(_req, res) {
  jsonResponse(res, 200, { ok: true, message: 'Shutting down…' });
  console.log('[server] Shutdown requested via API');
  if (_botHandle) { await _botHandle.stop(); _botHandle = null; }
  server.close(() => process.exit(0));
}

// ── Position history (delegated to src/position-history.js) ──────────────────

// ── Route table ──────────────────────────────────────────────────────────────

const _routes = {
  'GET /health':               (_, res) => jsonResponse(res, 200, { ok: true, port: config.PORT, ts: Date.now() }),
  'GET /api/status':           (_, res) => {
    const snap = { ...botState, walletAddress: walletManager.getAddress(), hodlBaseline: botState.hodlBaseline || null };
    // One-shot: clear oorRecoveredMin after delivering it so it doesn't re-show on refresh
    if (botState.oorRecoveredMin > 0) botState.oorRecoveredMin = 0;
    jsonResponse(res, 200, snap);
  },
  'GET /api/wallet/status':    (_, res) => jsonResponse(res, 200, walletManager.getStatus()),
  'DELETE /api/wallet':        (_, res) => { console.warn('[server] DELETE /api/wallet received — clearing wallet file'); walletManager.clearWallet(); jsonResponse(res, 200, { ok: true }); },
  'POST /api/config':          _handleApiConfig,
  'POST /api/wallet':          _handleWalletImport,
  'POST /api/wallet/reveal':   _handleWalletReveal,
  'POST /api/positions/scan':  _handlePositionsScan,
  'POST /api/position/switch': _handlePositionSwitch,
  'POST /api/rebalance':       async (req, res) => {
    if (!_botHandle || !botState.running) {
      jsonResponse(res, 409, { ok: false, error: 'Bot is syncing — wait for the "Synced" indicator, then try again.' });
      return;
    }
    let body = {};
    try { body = await readJsonBody(req); } catch { /* empty body OK */ }
    console.log('[server] Manual rebalance requested (customRange=%s)', body.customRangeWidthPct || 'default');
    const patch = { forceRebalance: true };
    if (body.customRangeWidthPct > 0) patch.customRangeWidthPct = Number(body.customRangeWidthPct);
    updateBotState(patch);
    jsonResponse(res, 200, { ok: true, message: 'Rebalance requested' });
  },
  'POST /api/shutdown':        _handleShutdown,
};

// ── Request router ────────────────────────────────────────────────────────────

/**
 * Main request handler.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 */
async function handleRequest(req, res) {
  const { method, url } = req;

  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const routeKey = method + ' ' + url;
  const handler  = _routes[routeKey];
  if (handler) {
    try {
      await handler(req, res);
    } catch (err) {
      const code = err.message === 'Wrong password' ? 403 : 400;
      jsonResponse(res, code, { ok: false, error: err.message });
    }
    return;
  }

  // ── Dynamic GET routes ──────────────────────────────────────────────────
  if (method === 'GET' && url.startsWith('/api/position/') && url.endsWith('/history')) {
    const tokenId = url.slice('/api/position/'.length, -'/history'.length);
    jsonResponse(res, 200, await getPositionHistory(tokenId, {
      rebalanceEvents: botState.rebalanceEvents, activePosition: botState.activePosition,
    }));
    return;
  }

  // ── Static files: / and /public/* ─────────────────────────────────────────
  // SPA catch-all: extensionless GET paths serve index.html (client-side routing)
  if (method === 'GET') {
    const served = serveStatic(url, res);
    if (!served) {
      const cleanPath = url.split('?')[0];
      if (!path.extname(cleanPath)) {
        serveStatic('/', res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      }
    }
    return;
  }

  // ── Catch-all ──────────────────────────────────────────────────────────────
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('405 Method Not Allowed');
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

/**
 * Start the server on the configured port and host.
 * Logs the dashboard URL to stdout on success.
 * @param {number} [portOverride]  Optional one-time port override (for tests).
 * @returns {Promise<http.Server>}
 */
function start(portOverride) {
  const port = portOverride !== undefined ? portOverride : config.PORT;
  const host = config.HOST;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
      console.log(`[server] Dashboard: ${addr}`);
      console.log(`[server] API:       ${addr}/api/status`);
      console.log(`[server] Port:      ${port}  (change with PORT= in .env)`);
      console.log(`[server] Health:    ${addr}/health`);
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
    server.close(err => (err ? reject(err) : resolve()));
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Only start automatically when run directly (`node server.js`).
// When required as a module (e.g. in tests), the caller controls lifecycle.
if (require.main === module) {
  start()
    .then(() => _tryStartBot(null))
    .then(() => {
      // Graceful shutdown on Ctrl-C / kill
      const shutdown = async () => {
        console.log('\n[server] Shutting down…');
        if (_botHandle) { await _botHandle.stop(); _botHandle = null; }
        server.close(() => process.exit(0));
        setTimeout(() => { console.log('[server] Force exit (connections still open)'); process.exit(0); }, 3000);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch(err => {
      console.error('[server] Failed to start:', err.message);
      process.exit(1);
    });
}

module.exports = { start, stop, updateBotState, botState, handleRequest };
