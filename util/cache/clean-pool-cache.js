#!/usr/bin/env node
/**
 * @file util/cache/clean-pool-cache.js
 * @description
 * Wipe every cached entry for a single pool from `tmp/`, so the next bot
 * run re-resolves that pool from scratch.  Used to verify cold-cache
 * paths (e.g. the pool-creation-block resolver fix in commit `c57339f`)
 * and to recover from suspected cache corruption for one pool.
 *
 * The tool requires `--chain` and `--nft-factory` so the 5-dimensional
 * pool scope (blockchain + nft-factory + token0 + token1 + fee) is
 * matched exactly.  Both can be read off the in-app "Pool Details"
 * dialog (header shows the blockchain; "NFT Contract" row shows the
 * nft-factory address).  Wallet is the only intentionally wildcarded
 * dimension so every wallet's entry for the same pool is wiped.
 *
 * See the engineering docs ("Utilities → Cache Utilities") for context.
 *
 * The CLI is self-documenting — run with `--help` for the full reference.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const config = require("../../src/config");

const TMP_DIR = path.join(process.cwd(), "tmp");
const POOL_CREATION_CACHE = path.join(
  TMP_DIR,
  "pool-creation-blocks-cache.json",
);
const GECKO_POOL_CACHE = path.join(TMP_DIR, "gecko-pool-cache.json");
const PNL_EPOCHS_CACHE = path.join(TMP_DIR, "pnl-epochs-cache.json");
const LIQUIDITY_PAIR_DETAILS_CACHE = path.join(
  TMP_DIR,
  "liquidity-pair-details-cache.json",
);
const CHAINS_JSON = path.join(
  process.cwd(),
  "app-config",
  "static-tunables",
  "chains.json",
);

const HELP_TEXT = `
clean-pool-cache.js — wipe every cached entry for one pool

USAGE
  node util/cache/clean-pool-cache.js <poolAddress> \\
       --chain <name> --nft-factory <addr> [options]

ARGUMENTS
  <poolAddress>
        0x-prefixed 20-byte hex address of the V3 pool to clean.
        Required.

REQUIRED OPTIONS
  --chain <name>
        Blockchain identifier.  Accepts either the abbreviated key
        (e.g. "pulsechain", "pulsechain-testnet") or the full
        human-readable display name (e.g. "PulseChain", "PulseChain
        Testnet v4").  Match is case-insensitive.  The set of valid
        values is whatever lives in app-config/static-tunables/
        chains.json on this checkout.

        How to find it: open the in-app "Pool Details" dialog
        (gear-icon area on the dashboard).  The blockchain name is
        printed as the subtitle directly beneath the "Pool Details"
        title at the top of the dialog.

  --nft-factory <addr>
        0x-prefixed 20-byte hex address of the NonfungiblePositionManager
        (the NFT-issuing contract for this pool's protocol — for 9mm
        Pro V3 on PulseChain that is
        0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2).

        How to find it: open the same "Pool Details" dialog.  The
        "NFT Contract" row in the details list shows this address.
        Click the copy icon next to it to copy.

OPTIONS
  --preserve-pool-history
        Skip the event-cache, P&L-epochs, and liquidity-pair-details
        surfaces.  Only the small lookup caches (pool-creation-blocks,
        gecko-pool) are cleared.  Use this when you want to verify a
        cold pool-creation-block lookup WITHOUT triggering a full
        event re-scan or losing accumulated P&L history for the pool.
        --chain and --nft-factory are still REQUIRED in this mode for
        consistency, even though they are not used by the lookup-only
        surfaces.

  -h, --help
        Print this message and exit.

DEFAULT BEHAVIOUR (no options)
  Cleans EVERY pool-scoped cache surface for the given pool:

    1. tmp/pool-creation-blocks-cache.json
         Removes every key whose value contains the pool address
         (matched as a case-insensitive substring of each key).

    2. tmp/gecko-pool-cache.json
         Removes every key containing the pool address.

    3. tmp/event-cache-*.json   (one file per wallet that has positions
                                 in this pool)
         Resolves (token0, token1, fee) by calling pool.token0/1/fee()
         on the address, then deletes every event-cache file whose
         filename matches both prefix
         event-cache-{chain:5}-{nftFactory:6hex}- AND suffix
         -{token0:8hex}-{token1:8hex}-{fee}.json (wallet wildcarded).

    4. tmp/pnl-epochs-cache.json
         Removes every internal key of the form
         {chain}.{nftFactory}.{wallet}.{token0}.{token1}.{fee} that
         matches the supplied chain + nft-factory + token0 + token1 +
         fee (wallet wildcarded), so accumulated P&L history for this
         pool configuration is dropped.

    5. tmp/liquidity-pair-details-cache.json
         Removes every top-level key whose prefix
         {chain:5}-{nftFactory:6hex}- AND suffix
         -{token0:8hex}-{token1:8hex}-{fee} match this pool's scope
         (wallet wildcarded). Drops the cached "Initial Wallet Residual
         (Pool)" snapshot so the next scan re-resolves wallet balances
         + historical prices at the first-mint block.

  Match dimensions enforced TOGETHER across surfaces 3-5: blockchain,
  nft-factory, token0, token1, fee. Wallet is the only intentionally
  wildcarded dimension — every wallet's entry for the same pool
  configuration is wiped.

  Caches that are NOT touched (intentional — not pool-scoped):
    - tmp/historical-price-cache.json   keyed by token + block
    - tmp/nft-mint-date-cache.json      keyed by tokenId
    - tmp/block-time-cache.json         keyed by chain + block

REQUIREMENTS
  Default mode reads token0/token1/fee from the pool via RPC.  Uses
  config.RPC_URL from .env (with config.RPC_URL_FALLBACK if primary
  fails).  If the RPC is unreachable, default mode aborts with a
  non-zero exit and surfaces 3-5 are NOT touched.  Use
  --preserve-pool-history to clean only the lookup caches without
  needing RPC.

EXAMPLES
  Full wipe (default), abbreviated chain name:
    node util/cache/clean-pool-cache.js \\
         0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9 \\
         --chain pulsechain \\
         --nft-factory 0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2

  Full wipe, full chain display name:
    node util/cache/clean-pool-cache.js \\
         0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9 \\
         --chain "PulseChain" \\
         --nft-factory 0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2

  Lookup-caches only (preserves event cache + P&L epochs):
    node util/cache/clean-pool-cache.js \\
         0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9 \\
         --chain pulsechain \\
         --nft-factory 0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2 \\
         --preserve-pool-history

  Print this help:
    node util/cache/clean-pool-cache.js --help

EXIT CODES
  0 — completed (even if zero entries matched)
  1 — invalid args, unparseable cache file, unknown blockchain, or
      RPC failure in default mode
`;

/* ---------- args ---------- */

function _consumeValueArg(name, argv, i) {
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`Error: ${name} requires a value.`);
    console.error("Run with --help for usage.");
    process.exit(1);
  }
  return v;
}

function parseArgs(argv) {
  const args = {
    pool: null,
    chain: null,
    factory: null,
    preserve: false,
    help: false,
  };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--preserve-pool-history") args.preserve = true;
    else if (a === "--chain") {
      args.chain = _consumeValueArg("--chain", list, i);
      i++;
    } else if (a === "--nft-factory") {
      args.factory = _consumeValueArg("--nft-factory", list, i);
      i++;
    } else if (/^0x[0-9a-fA-F]{40}$/.test(a) && !args.pool) args.pool = a;
    else {
      console.error(`Unknown argument: ${a}`);
      console.error("Run with --help for usage.");
      process.exit(1);
    }
  }
  return args;
}

/* ---------- chain registry resolution ---------- */

function loadChainsRegistry() {
  try {
    return JSON.parse(fs.readFileSync(CHAINS_JSON, "utf8"));
  } catch (err) {
    console.error(`Failed to read ${CHAINS_JSON}: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Resolve a user-supplied chain identifier to its canonical key from
 * chains.json.  Accepts either the registry key (e.g. "pulsechain")
 * or the human-readable displayName (e.g. "PulseChain").  Both are
 * matched case-insensitively.  Exits with a clear error message
 * listing the valid options when no match is found.
 */
function resolveChainKey(input, registry) {
  const needle = String(input || "")
    .trim()
    .toLowerCase();
  if (!needle) {
    console.error("Error: --chain value is empty.");
    process.exit(1);
  }
  for (const key of Object.keys(registry)) {
    const entry = registry[key] || {};
    if (
      key.toLowerCase() === needle ||
      String(entry.displayName || "").toLowerCase() === needle
    ) {
      return key;
    }
  }
  const valid = Object.keys(registry)
    .map((k) => `  - ${k}  (display: "${registry[k]?.displayName ?? k}")`)
    .join("\n");
  console.error(`Error: unknown blockchain "${input}".`);
  console.error("Valid values (key OR display name, case-insensitive):");
  console.error(valid);
  process.exit(1);
}

/**
 * Validate the supplied --nft-factory address.  Exits with a clear
 * message on missing/malformed input.
 */
function validateFactoryAddress(input) {
  if (!input) {
    console.error(
      "Error: --nft-factory <addr> is required (NonfungiblePositionManager address).",
    );
    console.error(
      "Find it in the in-app 'Pool Details' dialog → 'NFT Contract' row.",
    );
    console.error("Run with --help for usage.");
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) {
    console.error(
      `Error: --nft-factory value "${input}" is not a 0x-prefixed 20-byte hex address.`,
    );
    process.exit(1);
  }
  return input;
}

/* ---------- file IO ---------- */

function loadCacheOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Failed to parse ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

function saveCache(filePath, obj) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

function purgeMatchingKeys(filePath, cache, predicate) {
  const removed = [];
  for (const k of Object.keys(cache)) {
    if (predicate(k)) {
      removed.push(k);
      delete cache[k];
    }
  }
  if (removed.length > 0) saveCache(filePath, cache);
  return removed;
}

function reportFile(label, removed) {
  if (removed === null) {
    console.log(`  ${label}: (file absent — nothing to clean)`);
    return;
  }
  if (removed.length === 0) {
    console.log(`  ${label}: no matching entries`);
    return;
  }
  console.log(`  ${label}: removed ${removed.length} entry(ies)`);
  for (const k of removed) console.log(`    - ${k}`);
}

/* ---------- on-chain pool token/fee lookup ---------- */

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

async function resolvePoolTokens(pool) {
  const tryUrl = async (url) => {
    const provider = new ethers.JsonRpcProvider(url);
    const contract = new ethers.Contract(pool, POOL_ABI, provider);
    const [t0, t1, fee] = await Promise.all([
      contract.token0(),
      contract.token1(),
      contract.fee(),
    ]);
    return { token0: t0, token1: t1, fee: Number(fee) };
  };
  try {
    return await tryUrl(config.RPC_URL);
  } catch (err) {
    if (!config.RPC_URL_FALLBACK) throw err;
    console.warn(`  RPC primary failed (${err.message}); trying fallback…`);
    return await tryUrl(config.RPC_URL_FALLBACK);
  }
}

/* ---------- scope abbreviation helpers ----------
 *  Mirror the abbreviations used by liquidityPairScopeKey() in
 *  src/cache-store.js so that filename + key matches stay byte-identical
 *  to what the writers produce.  Match dimensions intentionally: chain,
 *  nft-factory, token0, token1, fee — wallet is wildcarded so we wipe
 *  every wallet's entry for the same pool configuration. */
function _abbrevScope({ blockchain, factory, token0, token1, fee }) {
  return {
    bc: (blockchain || "").slice(0, 5),
    pm: (factory || "").slice(2, 8).toLowerCase(),
    t0: (token0 || "").slice(2, 10).toLowerCase(),
    t1: (token1 || "").slice(2, 10).toLowerCase(),
    fee: String(fee),
  };
}

/* ---------- event-cache file globbing ---------- */

function findEventCacheFiles({ blockchain, factory, token0, token1, fee }) {
  const a = _abbrevScope({ blockchain, factory, token0, token1, fee });
  // Filename: event-cache-{bc}-{pm}-{wallet:6hex}-{t0}-{t1}-{fee}.json
  const prefix = `event-cache-${a.bc}-${a.pm}-`;
  const suffix = `-${a.t0}-${a.t1}-${a.fee}.json`;
  if (!fs.existsSync(TMP_DIR)) return [];
  return fs
    .readdirSync(TMP_DIR)
    .filter((n) => n.startsWith(prefix) && n.endsWith(suffix))
    .map((n) => path.join(TMP_DIR, n));
}

/* ---------- per-surface workers ---------- */

function _wipeEventCache(scope) {
  const evFiles = findEventCacheFiles(scope);
  if (evFiles.length === 0) {
    console.log("  event-cache-*.json: no matching files");
    return 0;
  }
  for (const f of evFiles) {
    fs.unlinkSync(f);
    console.log(`  event-cache: deleted ${path.basename(f)}`);
  }
  return evFiles.length;
}

function _wipePnlEpochs({ chainKey, factory, tokens }) {
  const epoch = loadCacheOrNull(PNL_EPOCHS_CACHE);
  const chainLower = chainKey.toLowerCase();
  const factoryLower = factory.toLowerCase();
  const t0Lower = tokens.token0.toLowerCase();
  const t1Lower = tokens.token1.toLowerCase();
  const feeStr = String(tokens.fee);
  const removed = epoch
    ? purgeMatchingKeys(PNL_EPOCHS_CACHE, epoch, (k) => {
        const parts = k.toLowerCase().split(".");
        if (parts.length < 6) return false;
        const [kchain, kfactory, , kt0, kt1, kfee] = parts;
        return (
          kchain === chainLower &&
          kfactory === factoryLower &&
          kt0 === t0Lower &&
          kt1 === t1Lower &&
          kfee === feeStr
        );
      })
    : null;
  reportFile("pnl-epochs-cache.json", removed);
  return removed ? removed.length : 0;
}

function _wipeLiquidityPairDetails(scope) {
  const a = _abbrevScope(scope);
  const pairDetails = loadCacheOrNull(LIQUIDITY_PAIR_DETAILS_CACHE);
  if (!pairDetails) {
    reportFile("liquidity-pair-details-cache.json", null);
    return 0;
  }
  const prefix = `${a.bc}-${a.pm}-`;
  const suffix = `-${a.t0}-${a.t1}-${a.fee}`;
  const removed = purgeMatchingKeys(
    LIQUIDITY_PAIR_DETAILS_CACHE,
    pairDetails,
    (k) => {
      const lk = k.toLowerCase();
      return lk.startsWith(prefix) && lk.endsWith(suffix);
    },
  );
  reportFile("liquidity-pair-details-cache.json", removed);
  return removed.length;
}

async function _resolveTokensOrExit(poolAddress) {
  try {
    console.log("");
    console.log("Resolving (token0, token1, fee) via RPC…");
    const tokens = await resolvePoolTokens(poolAddress);
    console.log(
      `  token0=${tokens.token0}  token1=${tokens.token1}  fee=${tokens.fee}`,
    );
    console.log("");
    return tokens;
  } catch (err) {
    console.error(`RPC lookup of pool tokens failed: ${err.message}`);
    console.error(
      "Aborting before touching event-cache, pnl-epochs, and liquidity-pair-details surfaces.",
    );
    console.error(
      "Re-run with --preserve-pool-history to clean only the lookup caches.",
    );
    process.exit(1);
  }
}

/* ---------- main ---------- */

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(HELP_TEXT.trim());
    process.exit(0);
  }
  if (!args.pool) {
    console.error("Error: missing required <poolAddress> argument.");
    console.error("Run with --help for usage.");
    process.exit(1);
  }
  if (!args.chain) {
    console.error("Error: --chain <name> is required.");
    console.error(
      'Find the blockchain name in the in-app "Pool Details" dialog (subtitle beneath the title).',
    );
    console.error(
      'Accepts the abbreviated key (e.g. "pulsechain") or the full display name (e.g. "PulseChain").',
    );
    console.error("Run with --help for usage.");
    process.exit(1);
  }
  const factory = validateFactoryAddress(args.factory);
  const registry = loadChainsRegistry();
  const chainKey = resolveChainKey(args.chain, registry);
  const chainDisplay = registry[chainKey]?.displayName || chainKey;

  const poolLower = args.pool.toLowerCase();
  console.log(`Cleaning pool: ${args.pool}`);
  console.log(`  Blockchain:   ${chainKey}  (${chainDisplay})`);
  console.log(`  NFT factory:  ${factory}`);
  console.log(
    `  Mode:         ${args.preserve ? "preserve-pool-history (lookup caches only)" : "full (every pool-scoped surface)"}`,
  );
  console.log("");

  /* 1. pool-creation-blocks-cache.json */
  const pcb = loadCacheOrNull(POOL_CREATION_CACHE);
  const pcbRemoved = pcb
    ? purgeMatchingKeys(POOL_CREATION_CACHE, pcb, (k) =>
        k.toLowerCase().includes(poolLower),
      )
    : null;
  reportFile("pool-creation-blocks-cache.json", pcbRemoved);

  /* 2. gecko-pool-cache.json */
  const gpc = loadCacheOrNull(GECKO_POOL_CACHE);
  const gpcRemoved = gpc
    ? purgeMatchingKeys(GECKO_POOL_CACHE, gpc, (k) =>
        k.toLowerCase().includes(poolLower),
      )
    : null;
  reportFile("gecko-pool-cache.json", gpcRemoved);

  let evCount = 0;
  let epochCount = 0;
  let pairDetailsCount = 0;

  if (!args.preserve) {
    const tokens = await _resolveTokensOrExit(args.pool);
    const scope = {
      blockchain: chainKey,
      factory,
      token0: tokens.token0,
      token1: tokens.token1,
      fee: tokens.fee,
    };
    evCount = _wipeEventCache(scope);
    epochCount = _wipePnlEpochs({ chainKey, factory, tokens });
    pairDetailsCount = _wipeLiquidityPairDetails(scope);
  }

  console.log("");
  const total =
    (pcbRemoved ? pcbRemoved.length : 0) +
    (gpcRemoved ? gpcRemoved.length : 0) +
    evCount +
    epochCount +
    pairDetailsCount;
  console.log(
    `Done. Removed ${total} entry(ies)/file(s) total across ${args.preserve ? 2 : 5} surface(s).`,
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
