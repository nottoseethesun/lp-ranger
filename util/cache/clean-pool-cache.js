#!/usr/bin/env node
/**
 * @file util/cache/clean-pool-cache.js
 * @description
 * Wipe every cached entry for a single pool from `tmp/`, so the next bot
 * run re-resolves that pool from scratch.  Used to verify cold-cache
 * paths (e.g. the pool-creation-block resolver fix in commit `c57339f`)
 * and to recover from suspected cache corruption for one pool.
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

const HELP_TEXT = `
clean-pool-cache.js — wipe every cached entry for one pool

USAGE
  node util/cache/clean-pool-cache.js <poolAddress> [options]

ARGUMENTS
  <poolAddress>
        0x-prefixed 20-byte hex address of the V3 pool to clean.
        Required.

OPTIONS
  --preserve-pool-history
        Skip the event-cache and P&L-epochs surfaces.  Only the small
        lookup caches (pool-creation-blocks, gecko-pool) are cleared.
        Use this when you want to verify a cold pool-creation-block
        lookup WITHOUT triggering a full event re-scan or losing
        accumulated P&L history for the pool.  Without this flag the
        cleaner is scorched-earth for the pool — every pool-scoped
        cache surface is wiped.

  -h, --help
        Print this message and exit.

DEFAULT BEHAVIOUR (no options)
  Cleans EVERY pool-scoped cache surface for the given pool:

    1. tmp/pool-creation-blocks-cache.json
         Removes the single key:  {factoryAddr}|{poolAddr}

    2. tmp/gecko-pool-cache.json
         Removes the single key:  {chain}-{poolAddr}

    3. tmp/event-cache-*.json   (one file per wallet that has positions
                                 in this pool)
         Resolves (token0, token1, fee) by calling pool.token0/1/fee()
         on the address, then deletes every event-cache file whose
         filename ends in -{token0:8hex}-{token1:8hex}-{fee}.json.

    4. tmp/pnl-epochs-cache.json
         Removes every internal key of the form
         {chain}.{factory}.{wallet}.{token0}.{token1}.{fee} — across
         every (factory, wallet) combination — so accumulated P&L
         history for this pool is dropped.

  Caches that are NOT touched (intentional — not pool-scoped):
    - tmp/historical-price-cache.json   keyed by token + block
    - tmp/nft-mint-date-cache.json      keyed by tokenId
    - tmp/block-time-cache.json         keyed by chain + block

OPTION COMBINATIONS
  (none)
        Full scorched-earth wipe (surfaces 1-4 above).

  --preserve-pool-history
        Wipe only surfaces 1 and 2.  Surfaces 3 and 4 are left intact.
        Use case: cold-test the pool-creation-block resolver without
        forcing a full event re-scan or discarding P&L history.

  --help (or -h, with or without a pool address)
        Print this help and exit 0.

REQUIREMENTS
  Default mode reads token0/token1/fee from the pool via RPC.  Uses
  config.RPC_URL from .env (with config.RPC_URL_FALLBACK if primary
  fails).  If the RPC is unreachable, default mode aborts with a
  non-zero exit and surfaces 3-4 are NOT touched.  Use
  --preserve-pool-history to clean only the lookup caches without
  needing RPC.

EXAMPLES
  Full wipe (default):
    node util/cache/clean-pool-cache.js 0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9

  Lookup-caches only (preserves event cache + P&L epochs):
    node util/cache/clean-pool-cache.js 0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9 --preserve-pool-history

  Print this help:
    node util/cache/clean-pool-cache.js --help

EXIT CODES
  0 — completed (even if zero entries matched)
  1 — invalid args, unparseable cache file, or RPC failure in default
      mode
`;

/* ---------- args ---------- */

function parseArgs(argv) {
  const args = { pool: null, preserve: false, help: false };
  for (const a of argv.slice(2)) {
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--preserve-pool-history") args.preserve = true;
    else if (/^0x[0-9a-fA-F]{40}$/.test(a)) args.pool = a;
    else {
      console.error(`Unknown argument: ${a}`);
      console.error("Run with --help for usage.");
      process.exit(1);
    }
  }
  return args;
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

/* ---------- event-cache file globbing ---------- */

function findEventCacheFiles(token0, token1, fee) {
  const t0 = token0.slice(2, 10).toLowerCase();
  const t1 = token1.slice(2, 10).toLowerCase();
  const suffix = `-${t0}-${t1}-${fee}.json`;
  if (!fs.existsSync(TMP_DIR)) return [];
  return fs
    .readdirSync(TMP_DIR)
    .filter((n) => n.startsWith("event-cache-") && n.endsWith(suffix))
    .map((n) => path.join(TMP_DIR, n));
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

  const poolLower = args.pool.toLowerCase();
  console.log(`Cleaning pool: ${args.pool}`);
  console.log(
    `Mode: ${args.preserve ? "preserve-pool-history (lookup caches only)" : "full (every pool-scoped surface)"}`,
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

  if (!args.preserve) {
    /* 3 + 4: need (token0, token1, fee) — fetch from chain */
    let tokens;
    try {
      console.log("");
      console.log("Resolving (token0, token1, fee) via RPC…");
      tokens = await resolvePoolTokens(args.pool);
      console.log(
        `  token0=${tokens.token0}  token1=${tokens.token1}  fee=${tokens.fee}`,
      );
      console.log("");
    } catch (err) {
      console.error(`RPC lookup of pool tokens failed: ${err.message}`);
      console.error(
        "Aborting before touching event-cache and pnl-epochs surfaces.",
      );
      console.error(
        "Re-run with --preserve-pool-history to clean only the lookup caches.",
      );
      process.exit(1);
    }

    /* 3. event-cache-*.json (multiple files) */
    const evFiles = findEventCacheFiles(
      tokens.token0,
      tokens.token1,
      tokens.fee,
    );
    if (evFiles.length === 0) {
      console.log("  event-cache-*.json: no matching files");
    } else {
      for (const f of evFiles) {
        fs.unlinkSync(f);
        console.log(`  event-cache: deleted ${path.basename(f)}`);
      }
      evCount = evFiles.length;
    }

    /* 4. pnl-epochs-cache.json */
    const epoch = loadCacheOrNull(PNL_EPOCHS_CACHE);
    const t0Lower = tokens.token0.toLowerCase();
    const t1Lower = tokens.token1.toLowerCase();
    const feeStr = String(tokens.fee);
    const epochRemoved = epoch
      ? purgeMatchingKeys(PNL_EPOCHS_CACHE, epoch, (k) => {
          const parts = k.toLowerCase().split(".");
          if (parts.length < 6) return false;
          const [, , , kt0, kt1, kfee] = parts;
          return kt0 === t0Lower && kt1 === t1Lower && kfee === feeStr;
        })
      : null;
    reportFile("pnl-epochs-cache.json", epochRemoved);
    epochCount = epochRemoved ? epochRemoved.length : 0;
  }

  console.log("");
  const total =
    (pcbRemoved ? pcbRemoved.length : 0) +
    (gpcRemoved ? gpcRemoved.length : 0) +
    evCount +
    epochCount;
  console.log(
    `Done. Removed ${total} entry(ies)/file(s) total across ${args.preserve ? 2 : 4} surface(s).`,
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
