#!/usr/bin/env node
/**
 * @file util/diagnostic/inspect-pool.js
 * @description
 * Read-only inspector that surfaces the bookkeeping fields most relevant
 * to Impermanent Loss / Gain (IL/G) investigations.  When a position's
 * dashboard IL/G looks suspect (e.g. a large phantom value after several
 * rebalances + a failed TX), this is the first tool to run — it shows
 * what the app *thinks* is true so you can compare to on-chain ground
 * truth via `reconcile-hodl.js`.
 *
 * What it reads (both files; missing tmp/ is tolerated):
 *   - app-config/.bot-config.json        — per-position cached state
 *   - tmp/pnl-epochs-cache.json          — per-pool epoch state
 *
 * What it prints:
 *   Per position (key = blockchain-wallet-contract-tokenId):
 *     - status (running / stopped)
 *     - initialDepositUsd, collectedFeesUsd, totalCompoundedUsd
 *     - hodlBaseline.{entryValue, hodlAmount0/1, token0/1UsdPrice,
 *       mintDate, mintTimestamp, mintGasWei}
 *     - residuals.{amount0, amount1}
 *     - pnlSnapshot.{totalIL, lifetimeIL, lifetimeDepositUsd,
 *       firstEpochDateUtc, closedEpochs[]} when present
 *     - compoundHistory length
 *
 *   Per pool (key = pulsechain.contract.wallet.token0.token1.fee):
 *     - cachedAt timestamp
 *     - liveEpoch.{startDate, netIL, totalFees, gasUsd}
 *     - closedEpochs count
 *     - lifetimeHodlAmounts.{amount0, amount1, lastBlock, deposits[]}
 *       (this is the running on-chain deposit total — drift between
 *       this and per-position hodlBaseline is the canonical cause of
 *       phantom IL/G)
 *     - freshDeposits count
 *
 * Behaviour:
 *   - Pure file reads.  No RPC, no mutations.  Safe while the bot is live.
 *   - "—" is shown for any field absent from the JSON (every field is
 *     optional — the file shape varies with bot version and history).
 *   - Filter argument is a case-insensitive substring matched against
 *     BOTH position composite keys AND epoch-cache pool keys, so a token
 *     contract fragment like "b4d363d5" matches the epoch entry even
 *     when no position composite key contains it.
 *
 * Usage:
 *   node util/diagnostic/inspect-pool.js                  # all positions + all epoch entries
 *   node util/diagnostic/inspect-pool.js <fragment>       # filter both sections
 *
 * Examples:
 *   node util/diagnostic/inspect-pool.js                  # full dump
 *   node util/diagnostic/inspect-pool.js 159250           # filter by tokenId
 *   node util/diagnostic/inspect-pool.js 0x4e44           # filter by wallet
 *   node util/diagnostic/inspect-pool.js b4d363d5         # filter by token contract (epoch cache only)
 *
 * Exit codes:
 *   0 — completed (even if no matches)
 *   1 — config file missing or unparseable
 *
 * Typical workflow:
 *   1. Run this tool to print cached state.
 *   2. If hodlAmount0/1 look stale, run reconcile-hodl.js to compare
 *      against on-chain Σ IncreaseLiquidity.
 *   3. If the rebalance lineage is unclear, run show-rebalance-chain.js
 *      to see every mint/drain on the wallet.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(process.cwd(), "app-config", ".bot-config.json");

const EPOCH_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  "pnl-epochs-cache.json",
);

/** Load JSON file or exit with a helpful error. */
function loadConfigOrExit() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`No config file at ${CONFIG_PATH}`);
    console.error(
      "Run the app at least once to create app-config/.bot-config.json.",
    );
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    console.error(`Failed to parse ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }
}

/** Format a number with N decimals, or "—" if missing. */
function fmtNum(v, decimals = 4) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(decimals);
}

/** Format a USD amount or "—". */
function fmtUsd(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
  return `$${Number(v).toFixed(2)}`;
}

/** Print one position's diagnostic block. */
function printPosition(key, pos) {
  const hb = pos.hodlBaseline || {};
  const res = pos.residuals || {};
  const snap = pos.pnlSnapshot || {};
  console.log("─".repeat(80));
  console.log(`Position: ${key}`);
  console.log(
    `  status:                 ${pos.status || "(absent → stopped)"}`,
  );
  console.log(`  initialDepositUsd:      ${fmtUsd(pos.initialDepositUsd)}`);
  console.log(`  collectedFeesUsd:       ${fmtUsd(pos.collectedFeesUsd)}`);
  console.log(`  totalCompoundedUsd:     ${fmtUsd(pos.totalCompoundedUsd)}`);
  console.log("  HODL baseline:");
  console.log(`    entryValue:           ${fmtUsd(hb.entryValue)}`);
  console.log(`    hodlAmount0:          ${fmtNum(hb.hodlAmount0, 6)}`);
  console.log(`    hodlAmount1:          ${fmtNum(hb.hodlAmount1, 6)}`);
  console.log(`    token0UsdPrice:       ${fmtNum(hb.token0UsdPrice, 8)}`);
  console.log(`    token1UsdPrice:       ${fmtNum(hb.token1UsdPrice, 8)}`);
  console.log(`    mintDate:             ${hb.mintDate || "—"}`);
  console.log(`    mintTimestamp:        ${hb.mintTimestamp ?? "—"}`);
  console.log(`    mintGasWei:           ${hb.mintGasWei || "—"}`);
  console.log("  residuals (raw token units):");
  console.log(`    amount0:              ${res.amount0 ?? "—"}`);
  console.log(`    amount1:              ${res.amount1 ?? "—"}`);
  console.log("  pnlSnapshot:");
  console.log(`    totalIL:              ${fmtUsd(snap.totalIL)}`);
  console.log(`    lifetimeIL:           ${fmtUsd(snap.lifetimeIL)}`);
  console.log(`    lifetimeDepositUsd:   ${fmtUsd(snap.lifetimeDepositUsd)}`);
  console.log(`    firstEpochDateUtc:    ${snap.firstEpochDateUtc || "—"}`);
  console.log(
    `    closedEpochs:         ${Array.isArray(snap.closedEpochs) ? snap.closedEpochs.length : "—"}`,
  );
  if (snap.liveEpoch) {
    console.log(
      `    liveEpoch start:      ${snap.liveEpoch.startDate || snap.liveEpoch.startedAt || "—"}`,
    );
  }
  if (Array.isArray(pos.compoundHistory) && pos.compoundHistory.length > 0) {
    console.log(
      `  compoundHistory:        ${pos.compoundHistory.length} entries`,
    );
  }
  console.log("");
}

/** Load epoch cache, returning {} on any failure. */
function loadEpochCache() {
  try {
    return JSON.parse(fs.readFileSync(EPOCH_CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Print a summary block for an epoch-cache pool entry. */
function printEpochEntry(key, entry) {
  console.log("─".repeat(80));
  console.log(`Pool epoch cache: ${key}`);
  console.log(`  cachedAt:               ${entry.cachedAt || "—"}`);
  if (entry.liveEpoch) {
    const le = entry.liveEpoch;
    console.log("  liveEpoch:");
    console.log(
      `    startDate:            ${le.startDate || le.startedAt || "—"}`,
    );
    console.log(`    netIL:                ${fmtUsd(le.netIL)}`);
    console.log(`    totalFees:            ${fmtUsd(le.totalFees)}`);
    console.log(`    gasUsd:               ${fmtUsd(le.gasUsd)}`);
  }
  console.log(
    `  closedEpochs:           ${Array.isArray(entry.closedEpochs) ? entry.closedEpochs.length : 0}`,
  );
  if (entry.lifetimeHodlAmounts) {
    const lh = entry.lifetimeHodlAmounts;
    console.log("  lifetimeHodlAmounts (pool-level on-chain truth):");
    console.log(`    amount0:              ${fmtNum(lh.amount0, 6)}`);
    console.log(`    amount1:              ${fmtNum(lh.amount1, 6)}`);
    console.log(`    lastBlock:            ${lh.lastBlock ?? "—"}`);
    console.log(
      `    deposits:             ${Array.isArray(lh.deposits) ? lh.deposits.length : 0}`,
    );
    if (Array.isArray(lh.deposits)) {
      for (const dep of lh.deposits) {
        console.log(
          `      block ${dep.block ?? "?"}: raw0=${dep.raw0} raw1=${dep.raw1}`,
        );
      }
    }
  }
  if (Array.isArray(entry.freshDeposits) && entry.freshDeposits.length > 0) {
    console.log(
      `  freshDeposits:          ${entry.freshDeposits.length} entries`,
    );
  }
  console.log("");
}

/** Filter epoch entries by wallet/contract fragment. */
function filterEpochByFragment(cache, fragment) {
  if (!fragment) return cache;
  const f = fragment.toLowerCase();
  const out = {};
  for (const [k, v] of Object.entries(cache)) {
    if (k.toLowerCase().includes(f)) out[k] = v;
  }
  return out;
}

/** Filter positions by a substring of the composite key. */
function filterPositions(positions, fragment) {
  if (!fragment) return positions;
  const f = fragment.toLowerCase();
  const out = {};
  for (const [k, v] of Object.entries(positions)) {
    if (k.toLowerCase().includes(f)) out[k] = v;
  }
  return out;
}

/** Main. */
function main() {
  const fragment = process.argv[2] || "";
  const cfg = loadConfigOrExit();
  const positions = cfg.positions || {};
  const filtered = filterPositions(positions, fragment);
  const keys = Object.keys(filtered).sort();
  console.log("=".repeat(80));
  console.log(`inspect-pool: ${CONFIG_PATH}`);
  if (fragment) console.log(`filter: "${fragment}"`);
  console.log(
    `${keys.length} of ${Object.keys(positions).length} position(s) shown`,
  );
  console.log("=".repeat(80));
  if (keys.length === 0) {
    console.log("(no position matches — checking epoch cache below)");
  } else {
    for (const k of keys) printPosition(k, filtered[k]);
  }

  /*- Epoch cache lives separately from .bot-config.json (in tmp/) and is
      keyed by pool identity, not tokenId.  Several positions in the same
      pool share one entry.  We surface it here because lifetimeHodlAmounts
      is the on-chain ground truth for IL math — drift between this and
      hodlBaseline above is the typical cause of phantom IL/G. */
  const epochAll = loadEpochCache();
  const epochFiltered = filterEpochByFragment(epochAll, fragment);
  const epochKeys = Object.keys(epochFiltered).sort();
  if (epochKeys.length > 0) {
    console.log("=".repeat(80));
    console.log(`Epoch cache: ${EPOCH_CACHE_PATH}`);
    console.log(
      `${epochKeys.length} of ${Object.keys(epochAll).length} pool entries shown`,
    );
    console.log("=".repeat(80));
    for (const k of epochKeys) printEpochEntry(k, epochFiltered[k]);
  }

  console.log("─".repeat(80));
  console.log("Done.");
}

if (require.main === module) {
  main();
}

module.exports = {
  fmtNum,
  fmtUsd,
  filterPositions,
  filterEpochByFragment,
};
