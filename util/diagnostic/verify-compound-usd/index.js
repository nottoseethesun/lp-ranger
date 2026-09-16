#!/usr/bin/env node
/**
 * @file util/diagnostic/verify-compound-usd/index.js
 * @description
 * Verifies a USD figure the bot reported for a liquidity event against
 * on-chain truth.  Written for the class of question: "the Telegram
 * alert said `Compounded $240.10 in fees`, but the NFT only accrued
 * about four dollars — which number is wrong, and why?"
 *
 * The bot never derives a compound's USD value from a price feed alone.
 * It multiplies three independent inputs, any one of which can be
 * wrong on its own:
 *
 *   usdValue = (amount0Deposited / 10^decimals0) × price0
 *            + (amount1Deposited / 10^decimals1) × price1
 *
 * (`src/compounder.js` `executeCompound`).  `amount0Deposited` /
 * `amount1Deposited` come from the `IncreaseLiquidity` event on the
 * deposit TX, the decimals from `poolState`, and the prices from
 * `deps._lastPrice0` / `_lastPrice1` — the last values
 * `src/bot-pnl-updater.js` `_fetchWithOverrides` resolved for the
 * position, which is either the live price cascade or a per-position
 * manual price override.  This tool re-derives all three from the
 * chain and from live price sources, then reports which input has to
 * be wrong to explain the reported figure.
 *
 * Why the figure matters beyond the alert text: `recordCompound` in
 * `src/bot-cycle-compound.js` adds the same `usdValue` to the
 * position's `totalCompoundedUsd`, which is half of the dashboard's
 * lifetime fee-earnings figure (`currentFeesUsd + totalCompoundedUsd`,
 * see `src/ui-state.js`).  That total is only ever accumulated
 * incrementally once disk holds a non-zero value — the on-chain
 * rescan in `src/bot-recorder-lifetime.js` is deliberately gated off
 * by `_resolveDiskState`.  So a single bad compound figure persists in
 * lifetime P&L until the value is corrected by hand.
 *
 * What it does
 * ────────────
 *   1. Resolves the position: a composite key (or unambiguous
 *      fragment) from `app-config/user-configurable/bot-config.json`,
 *      or a bare `--token-id` when the config lives on another host.
 *   2. Reads pool identity from chain: `positions(tokenId)` for
 *      token0 / token1 / fee, then `decimals()` and `symbol()` on both
 *      tokens.  Decimals are read from the contracts, never from
 *      config — a wrong cached decimal is one of the failure modes
 *      this tool exists to catch.
 *   3. Scans a block window (default 30 days) for this NFT's
 *      `IncreaseLiquidity`, `DecreaseLiquidity`, `Collect`, and
 *      mint (`Transfer` from the zero address) events.
 *   4. Classifies each `IncreaseLiquidity` as mint / compound /
 *      rebalance re-deposit by reusing the production classifier
 *      (`_filterRebalances` from `src/compounder.js`) so the labels
 *      match what the bot itself would conclude.
 *   5. Prices every event at live USD, and prints each price source
 *      (Moralis, GeckoTerminal, DexScreener) separately alongside the
 *      cascade result, so a single divergent source is visible.
 *   6. Compares against the recorded `compoundHistory` rows when the
 *      config is present: recorded `usdValue`, recorded `price0` /
 *      `price1`, versus live.
 *   7. Runs hypothesis checks on any gap — implied prices, a uniform
 *      price scale factor, and decimals-shift candidates.
 *
 * Reading the hypothesis block
 * ────────────────────────────
 *   - **implied price0 / price1** — the price that one token would
 *     have needed, holding the other at its live value, to produce the
 *     reported figure.  A ratio near 1.00× means that token is not the
 *     culprit; a large ratio names the bad input.  A negative implied
 *     price means that token alone cannot explain the figure.
 *   - **uniform scale** — the factor both prices would need.  Near a
 *     round number (10×, 100×) this points at a decimals or unit
 *     mix-up rather than a price feed.
 *   - **decimals shift** — every (decimals0, decimals1) pair within
 *     ±4 that reproduces the reported figure to within 5%.  A hit here
 *     means the amounts were divided by the wrong power of ten, not
 *     that a price was wrong.  Cross-check against the decimals heal /
 *     override path in `src/bot-recorder-lifetime.js` and the
 *     `decimalsOverride0` / `decimalsOverride1` /
 *     `decimalsOverrideForce0` / `decimalsOverrideForce1` config keys.
 *
 * `compoundHistory` spans the whole rebalance chain, not one NFT: it is
 * stored per *position*, and a position's composite key follows the
 * live NFT across rebalances, so the array accumulates rows for every
 * tokenId the chain has ever had.  Rows recorded against a sibling NFT
 * are reported as such, with the exact `--token-id` rerun command —
 * they are NOT reported as missing events, which would read as though
 * the bot had invented compounds that never happened.
 *
 * When a `compoundHistory` row is available the diagnosis is exact,
 * because the row stores the `price0` / `price1` the bot actually
 * used.  Two discriminators, in order:
 *
 *   - Recorded amounts differ from the chain's `IncreaseLiquidity`
 *     amounts → the bot recorded the wrong event.  Rare.
 *   - Recorded amounts match, and chain amounts × recorded prices
 *     reproduce the stored `usdValue` → the arithmetic was faithful
 *     and the **prices** were wrong.  Check whether `priceOverride0` /
 *     `priceOverride1` / `priceOverrideForce` are set on the position
 *     (`inspect-pool.js` prints them); otherwise the live cascade
 *     returned a bad value and the per-source table above says which
 *     provider to distrust.
 *   - Recorded amounts match but the prices do **not** reproduce the
 *     stored figure → the **decimals** were wrong.  The tool then
 *     re-runs the decimals-shift search against the recorded prices,
 *     which removes price drift and names the exact pair that was
 *     used.
 *
 * Read-only.  No mutations, no transactions.  Safe to run while the
 * bot is live.
 *
 * RPC behaviour
 * ─────────────
 *   - Uses `config.RPC_URL` (chain default when the env var is unset).
 *   - Log scans are chunked at 10 000 blocks with a 250 ms throttle,
 *     matching `src/event-scanner.js` conventions.  A 30-day window is
 *     roughly 26 chunks at PulseChain's ~10 s block time.
 *   - Never scans from block 0 — the window is always bounded by
 *     `--days` or `--from-block`.
 *
 * Caveats
 * ───────
 *   - Live prices are *today's*.  A figure reported days ago is
 *     compared against current prices, so a genuine market move shows
 *     up as a modest ratio.  Ratios worth investigating are the large
 *     ones; a 1.2× is probably just drift.
 *   - Moralis is the bot's primary source but needs an API key.
 *     Without one the tool reports it as unavailable rather than as
 *     `$0` — pass `--moralis-key` or set `MORALIS_API_KEY` to include
 *     it.  GeckoTerminal and DexScreener are keyless and are usually
 *     enough to bracket the true price.
 *   - When the mint predates the scan window the tool says so and
 *     classifies conservatively: with no in-window mint, no
 *     `IncreaseLiquidity` is labelled `mint`.
 *
 * Usage
 * ─────
 *   node util/diagnostic/verify-compound-usd <compositeKey-or-fragment>
 *   node util/diagnostic/verify-compound-usd --token-id <id>
 *
 * Options:
 *   --token-id <id>     Verify a bare NFT id; skips the config lookup
 *                       entirely.  Use on a host that does not have
 *                       the position's bot-config.json.
 *   --usd <amount>      A reported figure to explain (e.g. the number
 *                       from a Telegram alert).  Runs the hypothesis
 *                       checks against every in-window event even when
 *                       no config row is available.
 *   --days <n>          Scan window in days (default 30).
 *   --from-block <n>    Explicit window start; overrides --days.
 *   --moralis-key <key> Moralis API key, to include the bot's primary
 *                       price source.  Prefer the MORALIS_API_KEY
 *                       environment variable — a key passed as an
 *                       argument is visible in shell history and to
 *                       `ps`.  The key is never printed or logged.
 *   --help              Print this usage summary.
 *
 * Examples:
 *   # Explain a Telegram alert for a position in the local config:
 *   node util/diagnostic/verify-compound-usd 162980 --usd 240.10
 *
 *   # Same NFT from a machine without that position's config:
 *   node util/diagnostic/verify-compound-usd --token-id 162980 \
 *        --usd 240.10 --days 7
 *
 *   # Include the primary price source:
 *   MORALIS_API_KEY=… node util/diagnostic/verify-compound-usd 162980
 *
 * Tip: run `inspect-pool.js` first to list configured composite keys
 * and to see whether a manual price override is set on the position.
 *
 * Exit codes:
 *   0 — completed
 *   1 — bad arguments, config missing, key not found, or fragment
 *       ambiguous
 *   non-zero — RPC fatal error (printed to stderr)
 */

"use strict";

const fs = require("fs");
const path = require("path");

process.chdir(path.resolve(__dirname, "..", "..", ".."));

const { ethers } = require("ethers");
const config = require("../../../src/config");
const { PM_ABI } = require("../../../src/pm-abi");
const { setApiKey } = require("../../../src/api-key-holder");
const {
  fetchTokenPriceUsd,
  _fetchMoralisCurrent,
  _fetchGeckoTerminalCurrent,
  _fetchDexScreener,
} = require("../../../src/price-fetcher");
const { parseLogs: _parseLogs } = require("../../../src/nft-event-parse");
const { sleep } = require("../_helpers");
const { findPositionForTokenId, fmtUsd } = require("./analysis");
const {
  renderPrices,
  renderEvents,
  renderHypotheses,
  renderConfigComparison,
} = require("./render");

const CONFIG_PATH = path.join(
  process.cwd(),
  "app-config",
  "user-configurable",
  "bot-config.json",
);

/** Block time on PulseChain ≈ 10 s. */
const BLOCK_TIME_SEC = 10;

/** Default scan window in days. */
const DEFAULT_DAYS = 30;

const CHUNK_SIZE = 10000;
const CHUNK_DELAY_MS = 250;

/** Minimal ERC-20 surface: decimals + symbol, read straight from chain. */
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

/**
 * Parse CLI arguments.  Unknown flags are an error so a typo never
 * silently changes the scan window.
 *
 * @param {string[]} argv  Arguments after the script path.
 * @returns {{target: string|null, tokenId: string|null, usd: number|null,
 *   days: number, fromBlock: number|null, moralisKey: string|null,
 *   help: boolean, error: string|null}}
 */
function parseArgs(argv) {
  const out = {
    target: null,
    tokenId: null,
    usd: null,
    days: DEFAULT_DAYS,
    fromBlock: null,
    moralisKey: process.env.MORALIS_API_KEY || null,
    help: false,
    error: null,
  };
  const num = (v, label) => {
    const n = Number(v);
    if (!Number.isFinite(n)) out.error = `${label} needs a number, got "${v}"`;
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--token-id") out.tokenId = argv[++i];
    else if (a === "--usd") out.usd = num(argv[++i], "--usd");
    else if (a === "--days") out.days = num(argv[++i], "--days");
    else if (a === "--from-block")
      out.fromBlock = num(argv[++i], "--from-block");
    else if (a === "--moralis-key") out.moralisKey = argv[++i];
    else if (a.startsWith("-")) out.error = `unknown option: ${a}`;
    else if (out.target === null) out.target = a;
    else out.error = `unexpected argument: ${a}`;
  }
  if (!out.help && !out.target && !out.tokenId)
    out.error = "need a composite key / fragment, or --token-id";
  return out;
}

/**
 * Resolve a CLI argument (full composite key or fragment) to exactly
 * one configured position key.
 *
 * @param {object} positions  The config's `positions` map.
 * @param {string} arg        Key or fragment.
 * @returns {{key: string|null, error: string|null, matches: string[]}}
 */
function resolveKey(positions, arg) {
  if (positions[arg]) return { key: arg, error: null, matches: [arg] };
  const lc = arg.toLowerCase();
  const matches = Object.keys(positions).filter((k) =>
    k.toLowerCase().includes(lc),
  );
  if (matches.length === 0)
    return { key: null, error: `No position matches "${arg}".`, matches: [] };
  if (matches.length > 1)
    return { key: null, error: `"${arg}" is ambiguous.`, matches };
  return { key: matches[0], error: null, matches };
}

/** Extract the tokenId from a `blockchain-wallet-contract-tokenId` key. */
function tokenIdFromKey(key) {
  const parts = key.split("-");
  return parts.length === 4 ? parts[3] : null;
}

// ── chain + price I/O ───────────────────────────────────────────────────────

/**
 * Read pool identity and both tokens' on-chain decimals and symbols.
 *
 * @param {object} provider  ethers provider.
 * @param {string} tokenId
 * @returns {Promise<object>} `{token0, token1, fee, d0, d1, sym0, sym1,
 *   liquidity}`
 */
async function readPosition(provider, tokenId) {
  const pm = new ethers.Contract(config.POSITION_MANAGER, PM_ABI, provider);
  const p = await pm.positions(tokenId);
  const t0 = new ethers.Contract(p.token0, ERC20_ABI, provider);
  const t1 = new ethers.Contract(p.token1, ERC20_ABI, provider);
  const [d0, d1, sym0, sym1] = await Promise.all([
    t0.decimals(),
    t1.decimals(),
    t0.symbol().catch(() => "?"),
    t1.symbol().catch(() => "?"),
  ]);
  return {
    token0: p.token0,
    token1: p.token1,
    fee: Number(p.fee),
    d0: Number(d0),
    d1: Number(d1),
    sym0,
    sym1,
    liquidity: p.liquidity,
  };
}

/**
 * Scan one NFT's liquidity events over a bounded block window.
 * Four topic-filtered `getLogs` calls run in parallel per chunk.  The
 * mint scan (`Transfer` from the zero address) is what makes the
 * mint-vs-compound classification honest when the window is short.
 *
 * @param {object} provider  ethers provider.
 * @param {string} tokenId
 * @param {number} fromBlock
 * @param {number} toBlock
 * @returns {Promise<{il: object[], dl: object[], collect: object[],
 *   mintInWindow: boolean}>}
 */
async function scanEvents(provider, tokenId, fromBlock, toBlock) {
  const iface = new ethers.Interface(PM_ABI);
  const tidHex = "0x" + BigInt(tokenId).toString(16).padStart(64, "0");
  const zeroTopic = "0x" + "0".repeat(64);
  const topics = {
    il: [iface.getEvent("IncreaseLiquidity").topicHash, tidHex],
    dl: [iface.getEvent("DecreaseLiquidity").topicHash, tidHex],
    collect: [iface.getEvent("Collect").topicHash, tidHex],
    mint: [iface.getEvent("Transfer").topicHash, zeroTopic, null, tidHex],
  };
  const raw = { il: [], dl: [], collect: [], mint: [] };
  let cur = fromBlock;
  while (cur <= toBlock) {
    const end = Math.min(cur + CHUNK_SIZE - 1, toBlock);
    const names = Object.keys(topics);
    const results = await Promise.all(
      names.map((n) =>
        provider
          .getLogs({
            address: config.POSITION_MANAGER,
            fromBlock: cur,
            toBlock: end,
            topics: topics[n],
          })
          .catch((err) => {
            console.error(`  [chunk ${cur}-${end}] ${n}: ${err.message}`);
            return [];
          }),
      ),
    );
    names.forEach((n, i) => raw[n].push(...results[i]));
    cur = end + 1;
    await sleep(CHUNK_DELAY_MS);
  }
  return {
    il: _parseLogs(iface, raw.il),
    dl: _parseLogs(iface, raw.dl),
    collect: _parseLogs(iface, raw.collect),
    mintInWindow: raw.mint.length > 0,
  };
}

/**
 * Fetch a token's live USD price from the cascade and from each source
 * individually, so a single divergent provider is visible.
 *
 * @param {string} token  ERC-20 address.
 * @param {boolean} moralisKeyPresent  Whether a key was supplied.
 * @returns {Promise<{cascade: number, moralis: number|null,
 *   gecko: number, dex: number}>}
 */
async function pricesPerSource(token, moralisKeyPresent) {
  const cascade = await fetchTokenPriceUsd(token);
  const [moralis, gecko, dex] = await Promise.all([
    moralisKeyPresent ? _fetchMoralisCurrent(token) : Promise.resolve(null),
    _fetchGeckoTerminalCurrent(token).catch(() => 0),
    _fetchDexScreener(token).catch(() => 0),
  ]);
  return { cascade, moralis, gecko, dex };
}

// ── rendering ───────────────────────────────────────────────────────────────
// ── main ────────────────────────────────────────────────────────────────────

/**
 * Load bot config, or null when it is absent.
 *
 * @param {string} [configPath]  Defaults to the operator's real config;
 *   tests pass a fixture so no test run reads live position state.
 */
function loadConfig(configPath = CONFIG_PATH) {
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

/**
 * Resolve which tokenId to inspect and which config row (if any)
 * belongs to it.
 *
 * With `--token-id`, the config is still consulted — the rows for a
 * sibling NFT live under the position key of the chain's *current*
 * NFT, so skipping the lookup would silently drop the recorded-row
 * comparison for exactly the rerun this tool tells operators to run.
 * A missing config is not an error in that mode.
 *
 * @param {object} args  Parsed CLI args.
 * @param {string} [configPath]  Config location; injected for tests.
 * @returns {{tokenId: string, posConfig: object|null, key: string|null}}
 */
function resolveTarget(args, configPath = CONFIG_PATH) {
  if (args.tokenId) {
    const cfg = loadConfig(configPath);
    const found = cfg
      ? findPositionForTokenId(cfg.positions || {}, args.tokenId)
      : null;
    return {
      tokenId: args.tokenId,
      posConfig: found ? found.config : null,
      key: found ? found.key : null,
    };
  }
  const cfg = loadConfig(configPath);
  if (!cfg) {
    console.error(`No config at ${configPath} — use --token-id instead.`);
    process.exit(1);
  }
  const positions = cfg.positions || {};
  const res = resolveKey(positions, args.target);
  if (!res.key) {
    console.error(res.error);
    for (const k of res.matches.length ? res.matches : Object.keys(positions))
      console.error("  " + k);
    process.exit(1);
  }
  const tokenId = tokenIdFromKey(res.key);
  if (!tokenId) {
    console.error(`Cannot parse composite key: ${res.key}`);
    process.exit(1);
  }
  return { tokenId, posConfig: positions[res.key], key: res.key };
}

/** Print the usage summary (the Usage section of this file's header). */
function printHelp() {
  console.log(`
verify-compound-usd — explain a reported liquidity-event USD figure.

  node util/diagnostic/verify-compound-usd <compositeKey-or-fragment>
  node util/diagnostic/verify-compound-usd --token-id <id>

  --token-id <id>      Verify a bare NFT id; skips the config lookup.
  --usd <amount>       A reported figure to explain (e.g. a Telegram alert).
  --days <n>           Scan window in days (default ${DEFAULT_DAYS}).
  --from-block <n>     Explicit window start; overrides --days.
  --moralis-key <key>  Include the bot's primary price source.  Prefer the
                       MORALIS_API_KEY env var — an argument is visible to ps.
  --help               This message.

See the file header for how to read the hypothesis block.
`);
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.error) {
    console.error(args.error);
    printHelp();
    process.exit(1);
  }
  const { tokenId, posConfig, key } = resolveTarget(args);
  if (args.moralisKey) setApiKey("moralis", args.moralisKey);

  console.log("=".repeat(96));
  console.log(`verify-compound-usd: ${key || "NFT #" + tokenId}`);
  console.log("=".repeat(96));

  const provider = new ethers.JsonRpcProvider(config.RPC_URL);
  const pos = await readPosition(provider, tokenId);
  console.log("Position (read from chain)");
  console.log(`  token0: ${pos.sym0}  ${pos.token0}  decimals ${pos.d0}`);
  console.log(`  token1: ${pos.sym1}  ${pos.token1}  decimals ${pos.d1}`);
  console.log(`  fee:    ${pos.fee}`);

  const [px0, px1] = await Promise.all([
    pricesPerSource(pos.token0, !!args.moralisKey),
    pricesPerSource(pos.token1, !!args.moralisKey),
  ]);
  renderPrices(pos, px0, px1);
  const tok = { d0: pos.d0, d1: pos.d1, p0: px0.cascade, p1: px1.cascade };

  const head = await provider.getBlockNumber();
  const fromBlock =
    args.fromBlock ??
    Math.max(1, head - Math.round((args.days * 24 * 3600) / BLOCK_TIME_SEC));
  console.log(
    `\nScanning blocks ${fromBlock} → ${head} (${args.days} days at ` +
      `~${BLOCK_TIME_SEC}s/block)…`,
  );
  const scan = await scanEvents(provider, tokenId, fromBlock, head);
  const events = await renderEvents(provider, scan, pos, tok.p0, tok.p1);

  renderConfigComparison(posConfig, events, tok, tokenId);

  if (args.usd !== null) {
    console.log(`\nExplaining the reported figure ${fmtUsd(args.usd)}`);
    if (events.length === 0) console.log("  No events in the scan window.");
    for (const e of events) {
      console.log(`\n  ${e.kind} at ${e.when}  tx ${e.txHash || "—"}`);
      renderHypotheses(args.usd, e.ev, tok);
    }
  }
  console.log("\n" + "─".repeat(96));
  console.log("Done.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

/*- Only this module's own helpers are exported.  The pure analysis
 *  helpers belong to ./analysis.js and tests import them from there —
 *  re-exporting would give them two owners.
 *
 *  The render and scan functions are exported for the test suite: their
 *  observable behaviour is the text they print, so they are asserted by
 *  capturing console output rather than left uncovered. */
module.exports = {
  parseArgs,
  resolveKey,
  tokenIdFromKey,
  scanEvents,
  printHelp,
  loadConfig,
  resolveTarget,
};
