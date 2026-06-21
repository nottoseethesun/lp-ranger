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
const { HELP_TEXT } = require("./clean-pool-cache-help");

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
  "app-defaults-for-user-configurable",
  "chains.json",
);

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

/* ---------- lp-position-cache file globbing ---------- */

/**
 * Find every wallet-scoped lp-position-cache file for this chain +
 * nft-factory combination. The cache is wallet-scoped (lists every
 * position the wallet owns across all pools), so we wildcard the
 * wallet segment and surgically filter inside each file rather than
 * deleting it outright.
 */
function findLpPositionCacheFiles({ blockchain, factory }) {
  const a = _abbrevScope({ blockchain, factory });
  // Filename: lp-position-cache-{bc:5}-{pm:6}-{wallet:6hex}.json
  const prefix = `lp-position-cache-${a.bc}-${a.pm}-`;
  const suffix = `.json`;
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

/**
 * Pure filter: split a cached positions[] array into those that match
 * the pool scope (to be removed) and those that don't (to be kept).
 * Comparison is case-insensitive on token0/token1 and numeric on fee.
 *
 * Exported for tests — no IO, no logging.
 *
 * @param {object[]} positions  Position entries from a cache file.
 * @param {{token0:string, token1:string, fee:number|string}} scope
 * @returns {{ kept: object[], removed: object[] }}
 */
function filterPositionsForPool(positions, scope) {
  const t0Lower = String(scope.token0 || "").toLowerCase();
  const t1Lower = String(scope.token1 || "").toLowerCase();
  const feeNum = Number(scope.fee);
  const kept = [];
  const removed = [];
  for (const p of positions || []) {
    const pt0 = String(p.token0 || "").toLowerCase();
    const pt1 = String(p.token1 || "").toLowerCase();
    const pfee = Number(p.fee);
    if (pt0 === t0Lower && pt1 === t1Lower && pfee === feeNum) {
      removed.push(p);
    } else {
      kept.push(p);
    }
  }
  return { kept, removed };
}

/**
 * Surgically filter the cached `positions[]` array in every wallet's
 * lp-position-cache file, dropping entries whose (token0, token1, fee)
 * match this pool's scope. Other pools' entries in the same file are
 * preserved and the file's `lastBlock` cursor is left untouched.
 *
 * If a file's positions[] becomes empty after filtering, the whole
 * file is deleted (the freshness-check path treats a missing file as
 * "no cache" and rebuilds from chain).
 */
function _wipeLpPositionCache(scope) {
  const files = findLpPositionCacheFiles(scope);
  if (files.length === 0) {
    console.log("  lp-position-cache-*.json: no matching files");
    return 0;
  }
  let totalRemoved = 0;
  for (const f of files) {
    const data = loadCacheOrNull(f);
    if (
      !data ||
      !Array.isArray(data.positions) ||
      data.positions.length === 0
    ) {
      console.log(
        `  lp-position-cache: ${path.basename(f)}: nothing to filter`,
      );
      continue;
    }
    const before = data.positions.length;
    const { kept, removed } = filterPositionsForPool(data.positions, scope);
    if (removed.length === 0) {
      console.log(
        `  lp-position-cache: ${path.basename(f)}: no matching positions`,
      );
      continue;
    }
    totalRemoved += removed.length;
    if (kept.length === 0) {
      fs.unlinkSync(f);
      console.log(
        `  lp-position-cache: ${path.basename(f)}: removed ${removed.length} (file deleted — empty)`,
      );
    } else {
      saveCache(f, { positions: kept, lastBlock: data.lastBlock });
      console.log(
        `  lp-position-cache: ${path.basename(f)}: removed ${removed.length} of ${before} (kept ${kept.length})`,
      );
    }
  }
  return totalRemoved;
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
  let lpPosCount = 0;

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
    lpPosCount = _wipeLpPositionCache(scope);
  }

  console.log("");
  const total =
    (pcbRemoved ? pcbRemoved.length : 0) +
    (gpcRemoved ? gpcRemoved.length : 0) +
    evCount +
    epochCount +
    pairDetailsCount +
    lpPosCount;
  console.log(
    `Done. Removed ${total} entry(ies)/file(s) total across ${args.preserve ? 2 : 6} surface(s).`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}

module.exports = { filterPositionsForPool };
