#!/usr/bin/env node
/**
 * @file util/diagnostic/reconcile-hodl.js
 * @description
 * On-chain reconciler for a position's HODL baseline.  Answers the
 * question: "is the cached `hodlBaseline.hodlAmount0/1` still in sync
 * with the actual on-chain deposit history of this NFT chain?"  When
 * the answer is no, that drift is the typical cause of phantom IL/G
 * after several rebalances or a failed rebalance TX.
 *
 * Algorithm:
 *   1. Read the position's composite key from `app-config/.bot-config.json`.
 *   2. Call positions(tokenId) on the position manager to read the
 *      pool identity (token0, token1, fee).
 *   3. Walk Transfer events on the position manager (5-year lookback)
 *      to enumerate every tokenId ever minted to the wallet.
 *   4. Filter that list to NFTs in the same pool by calling
 *      positions(tid) on each.  Burned NFTs revert and are dropped —
 *      they don't matter because their IncreaseLiquidity logs are
 *      still queryable by topic in step 5.  (Note: this means burned
 *      NFTs from prior pools won't be included; for chain-walking
 *      purposes pools are treated as the unit of identity, and 9mm
 *      drains rather than burns, so this is rarely a concern.)
 *   5. For each in-pool tokenId, fetch its IncreaseLiquidity (IL),
 *      DecreaseLiquidity (DL), and Collect events via topic-filtered
 *      getLogs (single round-trip × 3 in parallel per tokenId).
 *   6. Aggregate raw BigInts across all NFTs and print:
 *        Σ IL  — gross deposits (mints + rebalance re-mints + compounds + fresh deposits)
 *        Σ DL  — gross drains (rebalance removes + closures)
 *        Σ Collect — gross collected (drains + fees)
 *        Net principal = max(Σ IL − Σ DL, 0)
 *        Approx fees   = max(Σ Collect − Σ DL, 0)
 *      Then compare Σ IL to the cached `hodlBaseline.hodlAmount0/1`
 *      and print the delta.
 *
 * Interpretation of the delta:
 *   - Δ ≈ 0 → cache is in sync with chain; phantom IL must come from
 *     elsewhere (price feed, rebalance log USD prices, residual math).
 *   - Δ > 0 → chain has more IL than cache: a fresh deposit was likely
 *     misclassified as a compound, OR a failed/orphan rebalance TX
 *     left a partial mint that was never reconciled.
 *   - Δ < 0 → cache has more than chain: rare; usually means the
 *     baseline was set with a manually edited value, or the wallet
 *     transferred an NFT in.
 *
 * Read-only.  No mutations.  Safe to run while the bot is live.
 *
 * RPC behaviour:
 *   - Uses config.RPC_URL (chain default if env unset).
 *   - Transfer scan is chunked at 10_000 blocks with 250 ms throttle
 *     (matches event-scanner.js conventions).
 *   - positions(tid) calls have a small 20 ms throttle.
 *   - Total RPC time is roughly proportional to chain age + NFT count.
 *
 * Caveats:
 *   - "Approx lifetime fees" double-counts when the bot has compounded:
 *     compounds re-collect into the SAME NFT, so they appear in both
 *     Collect AND the next IL.  Use this number as a sanity bound, not
 *     a precise fee figure — see lifetime-hodl.js for the production
 *     classifier.
 *   - Tokens with non-standard decimals are read via decimals() at
 *     reconcile time; the script trusts whatever the contract reports.
 *
 * Usage:
 *   node util/diagnostic/reconcile-hodl.js <compositeKey>
 *   node util/diagnostic/reconcile-hodl.js <fragment>     # must match exactly one position
 *
 * Composite key format: `blockchain-wallet-contract-tokenId`
 *
 * Examples:
 *   node util/diagnostic/reconcile-hodl.js pulsechain-0x4e44...-0xCC05...-159250
 *   node util/diagnostic/reconcile-hodl.js 159250         # tokenId fragment if unambiguous
 *
 * Tip: run `inspect-pool.js` first to list configured composite keys.
 *
 * Exit codes:
 *   0 — completed
 *   1 — config missing, key not found, or fragment ambiguous
 *   non-zero — RPC fatal error (printed to stderr)
 */

"use strict";

const fs = require("fs");
const path = require("path");

process.chdir(path.resolve(__dirname, "..", ".."));

const { ethers } = require("ethers");
const config = require("../../src/config");
const { PM_ABI } = require("../../src/pm-abi");
const { sleep, addrTopic } = require("./_helpers");

const CONFIG_PATH = path.join(process.cwd(), "app-config", ".bot-config.json");

/** Block time on PulseChain ≈ 10 s. */
const BLOCK_TIME_SEC = 10;

/** Lookback for chain walking (5y is enough to cover any LP). */
const YEARS_BACK = 5;

const CHUNK_SIZE = 10000;
const CHUNK_DELAY_MS = 250;

/** Load bot config or exit. */
function loadConfigOrExit() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`No config at ${CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

/** Resolve a CLI argument (full key or fragment) to exactly one composite key. */
function resolveKey(positions, arg) {
  if (positions[arg]) return arg;
  const lc = arg.toLowerCase();
  const matches = Object.keys(positions).filter((k) =>
    k.toLowerCase().includes(lc),
  );
  if (matches.length === 0) {
    console.error(`No position matches "${arg}".`);
    console.error("Configured positions:");
    for (const k of Object.keys(positions)) console.error("  " + k);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`"${arg}" is ambiguous.  Matches:`);
    for (const k of matches) console.error("  " + k);
    process.exit(1);
  }
  return matches[0];
}

/** Parse blockchain-wallet-contract-tokenId. */
function parseKey(key) {
  const parts = key.split("-");
  if (parts.length !== 4) return null;
  return {
    blockchain: parts[0],
    wallet: parts[1],
    contract: parts[2],
    tokenId: parts[3],
  };
}

/** Walk the wallet's NFT chain and find every tokenId at this PM contract. */
async function findAllTokenIds(provider, walletAddress, fromBlock, toBlock) {
  const iface = new ethers.Interface(PM_ABI);
  const transferTopic = iface.getEvent("Transfer").topicHash;
  const wTopic = addrTopic(walletAddress);
  const tokenIds = new Set();
  let cur = fromBlock;
  while (cur <= toBlock) {
    const end = Math.min(cur + CHUNK_SIZE - 1, toBlock);
    try {
      const inLogs = await provider.getLogs({
        address: config.POSITION_MANAGER,
        fromBlock: cur,
        toBlock: end,
        topics: [transferTopic, null, wTopic],
      });
      for (const l of inLogs) {
        try {
          tokenIds.add(BigInt(l.topics[3]).toString());
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.error(`  [chunk ${cur}-${end}] ${err.message}`);
    }
    cur = end + 1;
    await sleep(CHUNK_DELAY_MS);
  }
  return [...tokenIds];
}

/** Filter tokenIds to those whose position(...) matches the target pool. */
async function filterByPool(provider, tokenIds, target) {
  const pm = new ethers.Contract(config.POSITION_MANAGER, PM_ABI, provider);
  const matches = [];
  for (const tid of tokenIds) {
    try {
      const p = await pm.positions(tid);
      const t0 = p.token0.toLowerCase();
      const t1 = p.token1.toLowerCase();
      if (
        t0 === target.token0.toLowerCase() &&
        t1 === target.token1.toLowerCase() &&
        Number(p.fee) === Number(target.fee)
      ) {
        matches.push(tid);
      }
    } catch {
      /*- positions() reverts on burned NFTs.  These never matter for HODL
          reconciliation since the chain still has IncreaseLiquidity logs
          on them; we drop them and continue. */
    }
    await sleep(20);
  }
  return matches;
}

/** Sum IncreaseLiquidity / DecreaseLiquidity / Collect amounts for one tokenId. */
async function sumEvents(provider, tokenId) {
  const iface = new ethers.Interface(PM_ABI);
  const tidHex = "0x" + BigInt(tokenId).toString(16).padStart(64, "0");
  const ilTopic = iface.getEvent("IncreaseLiquidity").topicHash;
  const dlTopic = iface.getEvent("DecreaseLiquidity").topicHash;
  const cTopic = iface.getEvent("Collect").topicHash;
  const [il, dl, col] = await Promise.all([
    provider
      .getLogs({
        address: config.POSITION_MANAGER,
        fromBlock: 0,
        toBlock: "latest",
        topics: [ilTopic, tidHex],
      })
      .catch(() => []),
    provider
      .getLogs({
        address: config.POSITION_MANAGER,
        fromBlock: 0,
        toBlock: "latest",
        topics: [dlTopic, tidHex],
      })
      .catch(() => []),
    provider
      .getLogs({
        address: config.POSITION_MANAGER,
        fromBlock: 0,
        toBlock: "latest",
        topics: [cTopic, tidHex],
      })
      .catch(() => []),
  ]);
  const parsed = (logs) =>
    logs.map((l) => iface.parseLog({ topics: l.topics, data: l.data }));
  return {
    ilEvents: parsed(il),
    dlEvents: parsed(dl),
    collectEvents: parsed(col),
  };
}

/** Sum amount0/amount1 across an event list. */
function totals(events) {
  let s0 = 0n;
  let s1 = 0n;
  for (const e of events) {
    s0 += BigInt(e.args.amount0);
    s1 += BigInt(e.args.amount1);
  }
  return { s0, s1 };
}

/** BigInt → human float using token decimals. */
function toFloat(big, decimals) {
  if (big === 0n) return 0;
  const s = big.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, -decimals) || "0";
  const f = s.slice(-decimals);
  return Number(`${i}.${f}`);
}

/** Pretty diff between cached and on-chain. */
function fmtDelta(actual, cached, decimals) {
  const a = toFloat(actual, decimals);
  if (cached === undefined || cached === null || !Number.isFinite(cached))
    return `${a.toFixed(6)}  (cached: —)`;
  const d = a - Number(cached);
  const sign = d >= 0 ? "+" : "";
  return `${a.toFixed(6)}  (cached: ${Number(cached).toFixed(6)}, Δ ${sign}${d.toFixed(6)})`;
}

/** Main. */
async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "usage: node util/diagnostic/reconcile-hodl.js <compositeKey-or-fragment>",
    );
    process.exit(1);
  }
  const cfg = loadConfigOrExit();
  const positions = cfg.positions || {};
  const key = resolveKey(positions, arg);
  const pos = positions[key];
  const parsed = parseKey(key);
  if (!parsed) {
    console.error(`Cannot parse composite key: ${key}`);
    process.exit(1);
  }
  const wallet = ethers.getAddress(parsed.wallet);
  const provider = new ethers.JsonRpcProvider(config.RPC_URL);
  const pm = new ethers.Contract(config.POSITION_MANAGER, PM_ABI, provider);
  console.log("=".repeat(80));
  console.log(`reconcile-hodl: ${key}`);
  console.log("=".repeat(80));
  console.log("Reading current position metadata from chain...");
  const current = await pm.positions(parsed.tokenId);
  const target = {
    token0: current.token0,
    token1: current.token1,
    fee: Number(current.fee),
  };
  console.log(`  token0: ${target.token0}`);
  console.log(`  token1: ${target.token1}`);
  console.log(`  fee:    ${target.fee}`);
  const head = await provider.getBlockNumber();
  const fromBlock = Math.max(
    1,
    head - Math.round((YEARS_BACK * 365.25 * 24 * 3600) / BLOCK_TIME_SEC),
  );
  console.log(
    `\nWalking Transfer events to find every tokenId minted to ${wallet}...`,
  );
  const allTokens = await findAllTokenIds(provider, wallet, fromBlock, head);
  console.log(`  ${allTokens.length} tokenIds ever owned by this wallet`);
  console.log(`\nFiltering by pool (token0+token1+fee match)...`);
  const chain = await filterByPool(provider, allTokens, target);
  console.log(
    `  ${chain.length} tokenIds in the same pool: ${chain.join(", ")}`,
  );

  console.log(`\nFetching IL/DL/Collect events for each chained tokenId...`);
  const decimals0 = Number(
    await new ethers.Contract(
      target.token0,
      ["function decimals() view returns (uint8)"],
      provider,
    ).decimals(),
  );
  const decimals1 = Number(
    await new ethers.Contract(
      target.token1,
      ["function decimals() view returns (uint8)"],
      provider,
    ).decimals(),
  );
  console.log(`  decimals0=${decimals0}  decimals1=${decimals1}`);

  let ilSum0 = 0n;
  let ilSum1 = 0n;
  let dlSum0 = 0n;
  let dlSum1 = 0n;
  let colSum0 = 0n;
  let colSum1 = 0n;
  console.log("");
  console.log(
    "tokenId             IL_count  IL amount0       IL amount1       DL_count  Col_count",
  );
  for (const tid of chain) {
    const ev = await sumEvents(provider, tid);
    const il = totals(ev.ilEvents);
    const dl = totals(ev.dlEvents);
    const col = totals(ev.collectEvents);
    ilSum0 += il.s0;
    ilSum1 += il.s1;
    dlSum0 += dl.s0;
    dlSum1 += dl.s1;
    colSum0 += col.s0;
    colSum1 += col.s1;
    console.log(
      `${tid.padEnd(20)} ${String(ev.ilEvents.length).padStart(8)}  ${toFloat(il.s0, decimals0).toFixed(6).padStart(15)}  ${toFloat(il.s1, decimals1).toFixed(6).padStart(15)}  ${String(ev.dlEvents.length).padStart(8)}  ${String(ev.collectEvents.length).padStart(8)}`,
    );
    await sleep(50);
  }

  /*- Net principal = IL summed across the chain MINUS the
      already-decreased liquidity (drains during rebalance).  This is the
      best on-chain proxy for "amount of token still represented by the
      live position", ignoring fees. */
  const netPrincipal0 = ilSum0 > dlSum0 ? ilSum0 - dlSum0 : 0n;
  const netPrincipal1 = ilSum1 > dlSum1 ? ilSum1 - dlSum1 : 0n;

  /*- Lifetime fees ≈ Collect total − DL total (clamped ≥ 0).  Same heuristic
      used by lifetime-hodl / compounder. */
  const fees0 = colSum0 > dlSum0 ? colSum0 - dlSum0 : 0n;
  const fees1 = colSum1 > dlSum1 ? colSum1 - dlSum1 : 0n;

  console.log("\n" + "─".repeat(80));
  console.log("Aggregates (across full NFT chain):");
  console.log(
    `  Σ IncreaseLiquidity  amount0: ${toFloat(ilSum0, decimals0).toFixed(6)}   amount1: ${toFloat(ilSum1, decimals1).toFixed(6)}`,
  );
  console.log(
    `  Σ DecreaseLiquidity  amount0: ${toFloat(dlSum0, decimals0).toFixed(6)}   amount1: ${toFloat(dlSum1, decimals1).toFixed(6)}`,
  );
  console.log(
    `  Σ Collect            amount0: ${toFloat(colSum0, decimals0).toFixed(6)}   amount1: ${toFloat(colSum1, decimals1).toFixed(6)}`,
  );
  console.log(
    `  Net principal (IL−DL): amount0 ${toFloat(netPrincipal0, decimals0).toFixed(6)}  amount1 ${toFloat(netPrincipal1, decimals1).toFixed(6)}`,
  );
  console.log(
    `  Approx lifetime fees:  amount0 ${toFloat(fees0, decimals0).toFixed(6)}  amount1 ${toFloat(fees1, decimals1).toFixed(6)}`,
  );
  console.log("");
  console.log("HODL baseline reconciliation:");
  const cachedHb = pos.hodlBaseline || {};
  console.log(
    `  hodlAmount0:  on-chain Σ IL = ${fmtDelta(ilSum0, cachedHb.hodlAmount0, decimals0)}`,
  );
  console.log(
    `  hodlAmount1:  on-chain Σ IL = ${fmtDelta(ilSum1, cachedHb.hodlAmount1, decimals1)}`,
  );
  console.log("");
  console.log(
    "Notes: cached HODL is set once at first-mint detection; subsequent",
  );
  console.log(
    "  fresh deposits should grow it via the lifetime-deposit path.  A large",
  );
  console.log(
    "  Δ here means the cache and chain disagree — possible causes: a failed",
  );
  console.log(
    "  rebalance TX wasn't reconciled, or a fresh deposit was misclassified",
  );
  console.log(
    "  as a compound (or vice versa).  Re-running on a fresh restart with the",
  );
  console.log("  baseline cleared will rebuild it from chain.");
  console.log("─".repeat(80));
  console.log("Done.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

module.exports = {
  parseKey,
  totals,
  toFloat,
  fmtDelta,
};
