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
 *   GET  /api/status           → JSON: { global, positions: { [key]: {...} } }
 *   POST /api/config           → Update runtime config (throttle params, etc.)
 *   POST /api/position/manage  → Start managing a position (tokenId)
 *   POST /api/position/pause   → Pause a managed position (key)
 *   POST /api/position/resume  → Resume a paused position (key)
 *   DELETE /api/position/manage → Remove position from management (key)
 *   GET  /api/positions/managed → List all managed positions with status
 *   POST /api/rebalance        → Force-rebalance a position (positionKey)
 *   POST /api/shutdown         → Graceful shutdown (stops all positions + server)
 *   GET  /health               → 200 OK (used by load-balancers / pm2)
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
const { getPoolState: _getPoolState } = require('./src/rebalancer');
const { positionValueUsd: _posValueUsd, fetchTokenPrices: _fetchPrices, readUnclaimedFees: _readFees } = require('./src/bot-pnl-updater');
const rangeMath = require('./src/range-math');
const { getPositionBaseline } = require('./src/hodl-baseline');
const { computeHodlIL } = require('./src/il-calculator');
const { createRebalanceLock } = require('./src/rebalance-lock');
const { createPositionManager } = require('./src/position-manager');
const { loadConfig, saveConfig, getPositionConfig, readConfigValue, compositeKey: _compositeKey, GLOBAL_KEYS, POSITION_KEYS } = require('./src/bot-config-v2');

// ── Position manager (module-level) ──────────────────────────────────────────

const _rebalanceLock = createRebalanceLock();
const _positionMgr = createPositionManager({
  rebalanceLock: _rebalanceLock,
  dailyMax: config.MAX_REBALANCES_PER_DAY,
});

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

// ── Bot config persistence (v2) ──────────────────────────────────────────

/** V2 config loaded from disk (auto-migrates v1 on first load). */
const _diskConfig = loadConfig();

if (_diskConfig.managedPositions.length > 0) {
  console.log('[server] Loaded bot config v2 (%d managed positions)', _diskConfig.managedPositions.length);
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
  const globalPatch = {}, posPatch = {};
  for (const key of GLOBAL_KEYS) { if (body[key] !== undefined) globalPatch[key] = body[key]; }
  for (const key of POSITION_KEYS) { if (body[key] !== undefined) posPatch[key] = body[key]; }
  Object.assign(_diskConfig.global, globalPatch);
  // Apply position-specific keys to the specified position (or all managed)
  if (body.positionKey) {
    Object.assign(getPositionConfig(_diskConfig, body.positionKey), posPatch);
  } else {
    for (const key of _diskConfig.managedPositions) {
      Object.assign(getPositionConfig(_diskConfig, key), posPatch);
    }
  }
  saveConfig(_diskConfig);
  // Clear rebalancePaused when slippage changes so the bot retries with new setting
  if (globalPatch.slippagePct !== undefined) {
    for (const [, state] of getAllPositionBotStates()) {
      if (state.rebalancePaused) { state.rebalancePaused = false; state.rebalanceError = null; }
    }
  }
  jsonResponse(res, 200, { ok: true, applied: { ...globalPatch, ...posPatch } });
}

async function _handleWalletImport(req, res) {
  const body = await readJsonBody(req);
  console.log('[server] Wallet import requested for %s (running: %d positions)',
    body.address?.slice(0, 10), _positionMgr.runningCount());
  await walletManager.importWallet({
    address: body.address, privateKey: body.privateKey,
    mnemonic: body.mnemonic || null, source: body.source || 'key',
    password: body.password,
  });

  _persistWalletPassword(body.password);

  // Stop all running positions (new wallet = different positions)
  await _positionMgr.stopAll();
  jsonResponse(res, 200, { ok: true, address: body.address });

  // Resolve private key for future position starts
  _tryResolveKey(body.password).catch(err => {
    console.warn('[server] Key resolution after import failed:', err.message);
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
 * Resolve the private key and auto-start all managed positions from v2 config.
 * @param {string|null} [password]  Password override for wallet decryption.
 * @returns {Promise<void>}
 */
let _starting = false;
async function _tryResolveKey(password) {
  if (_starting) { console.log('[server] Start already in progress — skipping'); return; }
  _starting = true;
  const origWalletPw = config.WALLET_PASSWORD;
  if (password && !config.WALLET_PASSWORD) config.WALLET_PASSWORD = password;
  try {
    const privateKey = await resolvePrivateKey({ askPassword: null });
    if (!privateKey) {
      console.log('[server] No wallet key — dashboard-only mode. Import a wallet via the dashboard to start the bot.');
      return;
    }
    _resolvedPrivateKey = privateKey;
    // Auto-start all managed positions with status 'running'
    await _autoStartManagedPositions();
  } finally {
    config.WALLET_PASSWORD = origWalletPw;
    _starting = false;
  }
}

/**
 * Start bot loops for all managed positions that have status 'running' in config.
 * Called on server startup and after key resolution.
 */
async function _autoStartManagedPositions() {
  const { createPerPositionBotState, attachMultiPosDeps, updatePositionState } = require('./src/server-positions');
  const count = _diskConfig.managedPositions.length;
  const staggerMs = count > 1 ? Math.floor((config.CHECK_INTERVAL_SEC * 1000) / count) : 0;
  let i = 0;
  for (const key of _diskConfig.managedPositions) {
    const posConfig = getPositionConfig(_diskConfig, key);
    if (posConfig.status !== 'running') {
      console.log('[server] Skipping paused position %s', key);
      i++;
      continue;
    }
    if (i > 0 && staggerMs > 0) {
      console.log('[server] Stagger delay: %dms before starting position %d/%d', staggerMs, i + 1, count);
      await new Promise((r) => setTimeout(r, staggerMs));
    }
    const tokenId = key.split('-').pop();
    const posBotState = createPerPositionBotState(_diskConfig.global, posConfig);
    attachMultiPosDeps(posBotState, _positionMgr);
    try {
      const keyRef = { current: key };
      await _positionMgr.startPosition(key, {
        tokenId,
        startLoop: () => startBotLoop({
          privateKey: _resolvedPrivateKey, dryRun: config.DRY_RUN,
          updateBotState: (patch) => updatePositionState(keyRef, patch, _diskConfig, _positionMgr),
          botState: posBotState, positionId: tokenId,
          getConfig: (k) => readConfigValue(_diskConfig, keyRef.current, k),
        }),
        savedConfig: posConfig,
      });
    } catch (err) {
      console.warn('[server] Failed to auto-start position %s: %s', key, err.message);
    }
    i++;
  }
  console.log('[server] Auto-started %d of %d managed positions',
    _positionMgr.runningCount(), _diskConfig.managedPositions.length);
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

  // Fetch current tick for each unique pool (for in-range display)
  const poolTickMap = {};
  const { getPoolState } = require('./src/rebalancer');
  const pools = new Set((result.nftPositions || []).filter(p => p.fee && p.fee > 0).map(p => p.token0 + '-' + p.token1 + '-' + p.fee));
  await Promise.all([...pools].map(async (key) => {
    try {
      const [t0, t1, fee] = key.split('-'); const feeN = Number(fee);
      const ps = await getPoolState(provider, ethers, { factoryAddress: config.FACTORY, token0: t0, token1: t1, fee: feeN });
      poolTickMap[key] = ps.tick;
    } catch { /* pool query failed — skip */ }
  }));

  jsonResponse(res, 200, {
    ok: true, type: result.type, positionManagerAddress: pmAddr,
    nftPositions: (result.nftPositions || []).map(p => ({
      ...p, tokenId: String(p.tokenId), liquidity: String(p.liquidity),
      token0Symbol: symbolMap[p.token0] || '?', token1Symbol: symbolMap[p.token1] || '?',
      poolTick: poolTickMap[p.token0 + '-' + p.token1 + '-' + p.fee] ?? null,
    })),
    erc20Positions: (result.erc20Positions || []).map(p => ({
      ...p,
      token0Symbol: p.token0 ? (symbolMap[p.token0] || '?') : '?',
      token1Symbol: p.token1 ? (symbolMap[p.token1] || '?') : '?',
    })),
  });
}

async function _handleShutdown(_req, res) {
  jsonResponse(res, 200, { ok: true, message: 'Shutting down…' });
  console.log('[server] Shutdown requested via API');
  await _positionMgr.stopAll();
  server.close(() => process.exit(0));
}

// ── Position history (delegated to src/position-history.js) ──────────────────

// ── Multi-position management (delegated to src/server-positions.js) ─────────

const { createPositionRoutes } = require('./src/server-positions');

/** Resolved private key — set once during bot start, shared across all loops. */
let _resolvedPrivateKey = null;

const _positionRoutes = createPositionRoutes({
  diskConfig: _diskConfig,
  positionMgr: _positionMgr,
  walletManager,
  getPrivateKey: () => _resolvedPrivateKey,
  jsonResponse,
  readJsonBody,
});

// ── One-shot position details (unmanaged positions) ─────────────────────────

/** Load or fetch + cache the HODL baseline for a position. */
async function _resolveBaseline(provider, ethersLib, position, posKey) {
  const saved = _diskConfig.positions[posKey]?.hodlBaseline;
  if (saved && saved.entryValue > 0) return saved;
  const baseline = await getPositionBaseline(provider, ethersLib, position);
  if (baseline) { const pos = getPositionConfig(_diskConfig, posKey); pos.hodlBaseline = baseline; saveConfig(_diskConfig); }
  return baseline;
}

/** Compute P&L fields from baseline + current data. */
function _computePnlFields(baseline, value, price0, price1, feesUsd, userDeposit) {
  const ev = userDeposit > 0 ? userDeposit : (baseline?.entryValue || 0);
  const pgl = ev > 0 ? value - ev : null;
  const il = baseline ? computeHodlIL({ lpValue: value, hodlAmount0: baseline.hodlAmount0, hodlAmount1: baseline.hodlAmount1, currentPrice0: price0, currentPrice1: price1 }) : null;
  return { entryValue: ev, priceGainLoss: pgl, il, netPnl: ev > 0 ? (pgl || 0) + feesUsd : null, profit: il !== null ? feesUsd + il : null,
    mintDate: baseline?.mintDate || null, mintTimestamp: baseline?.mintTimestamp || null, hodlAmount0: baseline?.hodlAmount0 ?? null, hodlAmount1: baseline?.hodlAmount1 ?? null };
}

async function _handlePositionDetails(req, res) {
  const body = await readJsonBody(req);
  if (!body.tokenId || !body.token0 || !body.token1 || !body.fee) {
    return jsonResponse(res, 400, { ok: false, error: 'Missing tokenId, token0, token1, or fee' });
  }
  const ethersLib = require('ethers');
  try {
    const provider = new ethersLib.JsonRpcProvider(config.RPC_URL);
    const ps = await _getPoolState(provider, ethersLib, { factoryAddress: config.FACTORY, token0: body.token0, token1: body.token1, fee: body.fee });
    const { price0, price1 } = await _fetchPrices(body.token0, body.token1);
    const position = { tokenId: body.tokenId, token0: body.token0, token1: body.token1, fee: body.fee,
      tickLower: body.tickLower, tickUpper: body.tickUpper, liquidity: body.liquidity };
    const value = _posValueUsd(position, ps, price0, price1);
    const amounts = rangeMath.positionAmounts(BigInt(body.liquidity || 0), ps.tick, body.tickLower, body.tickUpper, ps.decimals0, ps.decimals1);
    const lp = rangeMath.tickToPrice(body.tickLower, ps.decimals0, ps.decimals1);
    const up = rangeMath.tickToPrice(body.tickUpper, ps.decimals0, ps.decimals1);
    const inRange = ps.tick >= body.tickLower && ps.tick < body.tickUpper;
    let feesUsd = 0;
    if (_resolvedPrivateKey) {
      try {
        const signer = new ethersLib.Wallet(_resolvedPrivateKey, provider);
        const fees = await _readFees(provider, ethersLib, body.tokenId, signer);
        feesUsd = (Number(fees.tokensOwed0) / 10 ** ps.decimals0) * price0 + (Number(fees.tokensOwed1) / 10 ** ps.decimals1) * price1;
      } catch (_) { /* fees unavailable without signer */ }
    }
    const poolState = { tick: ps.tick, price: ps.price, decimals0: ps.decimals0, decimals1: ps.decimals1, poolAddress: ps.poolAddress };
    const total = amounts.amount0 * price0 + amounts.amount1 * price1;
    const comp = total > 0 ? (amounts.amount0 * price0) / total : null;
    const walletAddr = body.walletAddress || walletManager.getAddress() || '';
    const posKey = _compositeKey('pulsechain', walletAddr, body.contractAddress || config.POSITION_MANAGER, body.tokenId);
    const baseline = await _resolveBaseline(provider, ethersLib, position, posKey);
    const userDeposit = _diskConfig.positions[posKey]?.initialDepositUsd || 0;
    const pnl = _computePnlFields(baseline, value, price0, price1, feesUsd, userDeposit);
    jsonResponse(res, 200, { ok: true, poolState, price0, price1, value, amounts, feesUsd, inRange, lowerPrice: lp, upperPrice: up, composition: comp, ...pnl });
  } catch (err) {
    console.error('[server] Position details error:', err.message);
    jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

// ── Route table ──────────────────────────────────────────────────────────────

const { getAllPositionBotStates } = require('./src/server-positions');

const _routes = {
  'GET /health':               (_, res) => jsonResponse(res, 200, { ok: true, port: config.PORT, ts: Date.now() }),
  'GET /api/status':           (_, res) => {
    const positions = {};
    const posDefaults = { rebalanceOutOfRangeThresholdPercent: config.REBALANCE_OOR_THRESHOLD_PCT, rebalanceTimeoutMin: config.REBALANCE_TIMEOUT_MIN };
    for (const [key, state] of getAllPositionBotStates()) {
      const posConfig = _diskConfig.positions[key] || {};
      positions[key] = { ...posDefaults, ...state, ...posConfig };
    }
    jsonResponse(res, 200, {
      global: {
        walletAddress: walletManager.getAddress(),
        port: config.PORT, host: config.HOST, rpcUrl: config.RPC_URL,
        positionManager: config.POSITION_MANAGER, factory: config.FACTORY,
        rebalanceOutOfRangeThresholdPercent: config.REBALANCE_OOR_THRESHOLD_PCT,
        rebalanceTimeoutMin: config.REBALANCE_TIMEOUT_MIN,
        ..._diskConfig.global,
        dailyRebalanceCount: _positionMgr.getDailyCount(),
        managedPositions: _positionMgr.getAll(),
      },
      positions,
    });
  },
  'GET /api/wallet/status':    (_, res) => jsonResponse(res, 200, walletManager.getStatus()),
  'DELETE /api/wallet':        (_, res) => { console.warn('[server] DELETE /api/wallet received — clearing wallet file'); walletManager.clearWallet(); jsonResponse(res, 200, { ok: true }); },
  'POST /api/config':          _handleApiConfig,
  'POST /api/wallet':          _handleWalletImport,
  'POST /api/wallet/reveal':   _handleWalletReveal,
  'POST /api/positions/scan':  _handlePositionsScan,
  'POST /api/rebalance':       async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req); } catch { /* empty body OK */ }
    if (!body.positionKey) {
      jsonResponse(res, 400, { ok: false, error: 'Missing positionKey' });
      return;
    }
    const state = getAllPositionBotStates().get(body.positionKey);
    if (!state || !state.running) {
      jsonResponse(res, 409, { ok: false, error: 'Position not running or syncing' });
      return;
    }
    console.log('[server] Manual rebalance for %s (customRange=%s)', body.positionKey, body.customRangeWidthPct || 'default');
    state.forceRebalance = true; state.rebalancePaused = false; state.rebalanceError = null;
    if (body.customRangeWidthPct > 0) state.customRangeWidthPct = Number(body.customRangeWidthPct);
    jsonResponse(res, 200, { ok: true, message: 'Rebalance requested' });
  },
  'POST /api/position/details': _handlePositionDetails,
  'POST /api/shutdown':        _handleShutdown,

  // ── Multi-position management ──────────────────────────────────────────
  ..._positionRoutes,
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
    // Find the position state that matches this tokenId
    let posState = null;
    for (const [, s] of getAllPositionBotStates()) {
      if (s.activePosition && String(s.activePosition.tokenId) === tokenId) { posState = s; break; }
    }
    jsonResponse(res, 200, await getPositionHistory(tokenId, {
      rebalanceEvents: posState?.rebalanceEvents, activePosition: posState?.activePosition,
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
    .then(() => _tryResolveKey(null))
    .then(() => {
      const shutdown = () => {
        console.log('\n[server] Shutting down…');
        _positionMgr.stopAll().catch(() => {});
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch(err => {
      console.error('[server] Failed to start:', err.message);
      process.exit(1);
    });
}

module.exports = { start, stop, handleRequest, _diskConfig, _positionMgr };
