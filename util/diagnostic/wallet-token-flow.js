#!/usr/bin/env node
/**
 * @file util/diagnostic/wallet-token-flow.js
 * @description
 * Scans ERC-20 `Transfer(from, to, value)` events for one or more tokens,
 * filtered to those that touch a wallet, within a UTC time window.  Prints
 * every IN/OUT movement with timestamp, counterparty, and human-readable
 * amount.  Native PLS is NOT included — native transfers don't emit
 * Transfer events.  When an LP user "deposits PLS", the wrap step emits a
 * Transfer of WPLS from the WPLS contract (from=0x0 in some wrap
 * implementations, or from=WPLS-contract); both shapes show up here.
 *
 * Why this exists:
 *   The `lifetime-hodl` fresh-deposit detector already classifies
 *   wallet movements into deposit / swap / drain / rebalance-recycle.
 *   When its output disagrees with the user's recollection of what they
 *   actually deposited, this tool gives the unfiltered ground truth so
 *   we can see what the classifier saw and where it went wrong.
 *
 * What it queries:
 *   - For each TOKEN address: two parallel chunked getLogs calls
 *       Transfer(*, wallet)   — every credit
 *       Transfer(wallet, *)   — every debit
 *   - Block timestamps for each unique block hosting a Transfer.
 *   - Token decimals via decimals() at scan start.
 *   - Token symbol via symbol() at scan start (for header display).
 *
 * What it prints (one line per Transfer):
 *   DIR  BLOCK     TIMESTAMP (UTC)        AMOUNT          SYMBOL  COUNTERPARTY  TX
 *
 * Plus a per-token net-flow summary at the end (Σ in − Σ out).
 *
 * Read-only.  No mutations.  Safe while the bot is live.
 *
 * RPC behaviour:
 *   - 10_000-block chunks with 250 ms throttle.
 *   - Uses the chain default RPC unless RPC_URL is set.
 *   - Block-window estimate: PulseChain ≈ 10 s/block → 1 day ≈ 8640 blocks.
 *
 * Date window:
 *   - Argument format: --from=YYYY-MM-DD --to=YYYY-MM-DD (UTC inclusive)
 *   - If both omitted: defaults to "last 24 h".
 *   - If only --from: scans from that date to head.
 *   - The window is converted to a block range via head + per-block
 *     time estimate (no eth_getBlockByNumber binary search, so the
 *     range is approximate by ±a few minutes — fine for human-readable
 *     diagnosis).
 *
 * Usage:
 *   node util/diagnostic/wallet-token-flow.js <wallet> <token>[,token2,...] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *
 * Arguments:
 *   wallet      — 20-byte hex, EIP-55 or lowercase
 *   token list  — comma-separated 20-byte hex token addresses
 *   --from=DATE — UTC start date (inclusive).  Default: 24 h before head.
 *   --to=DATE   — UTC end date   (inclusive).  Default: now.
 *
 * Examples:
 *   # Today's WPLS + PLSX flow on the wallet
 *   node util/diagnostic/wallet-token-flow.js \
 *     0x4e44847675763D5540B32Bee8a713CfDcb4bE61A \
 *     0xA1077a294dDE1B09bB078844df40758a5D0f9a27,0x95B303987A60C71504D99Aa1b13B4DA07b0790ab \
 *     --from=2026-04-28 --to=2026-04-28
 *
 *   # Last 24 hours, defaults
 *   node util/diagnostic/wallet-token-flow.js 0x4e44... 0xA1077a...
 *
 * Exit codes:
 *   0 — completed
 *   1 — bad arguments
 *   non-zero — RPC fatal error
 */

"use strict";

const path = require("path");

process.chdir(path.resolve(__dirname, "..", ".."));

const { ethers } = require("ethers");
const config = require("../../src/config");
const helpers = require("./_helpers");

const { sleep, addrTopic, fmtTs } = helpers;
const addrFromTopic = (t) => helpers.addrFromTopic(t, ethers);

const BLOCK_TIME_SEC = 10;
const CHUNK_SIZE = 10000;
const CHUNK_DELAY_MS = 250;

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

/** Parse --from/--to argument or return null. */
function parseDateArg(arg) {
  const m = arg.match(/^--(from|to)=(\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  return { kind: m[1], date: m[2] };
}

/** Convert UTC YYYY-MM-DD → unix seconds at midnight UTC. */
function dateStartSec(yyyymmdd) {
  return Math.floor(Date.parse(`${yyyymmdd}T00:00:00Z`) / 1000);
}

/** Convert UTC YYYY-MM-DD → unix seconds at end-of-day UTC (23:59:59). */
function dateEndSec(yyyymmdd) {
  return Math.floor(Date.parse(`${yyyymmdd}T23:59:59Z`) / 1000);
}

/** Format raw BigInt with decimals. */
function fmtAmount(big, decimals) {
  if (big === 0n) return "0";
  const s = big.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, -decimals) || "0";
  const f = s.slice(-decimals).replace(/0+$/, "");
  return f.length > 0 ? `${i}.${f.slice(0, 8)}` : i;
}

/** Scan Transfer logs for one token in [fromBlock, toBlock]. */
async function scanToken(provider, tokenAddr, walletAddr, fromBlock, toBlock) {
  const iface = new ethers.Interface(ERC20_ABI);
  const tTopic = iface.getEvent("Transfer").topicHash;
  const wTopic = addrTopic(walletAddr);
  const all = [];
  let cur = fromBlock;
  while (cur <= toBlock) {
    const end = Math.min(cur + CHUNK_SIZE - 1, toBlock);
    try {
      const [inLogs, outLogs] = await Promise.all([
        provider.getLogs({
          address: tokenAddr,
          fromBlock: cur,
          toBlock: end,
          topics: [tTopic, null, wTopic],
        }),
        provider.getLogs({
          address: tokenAddr,
          fromBlock: cur,
          toBlock: end,
          topics: [tTopic, wTopic, null],
        }),
      ]);
      for (const l of inLogs) all.push({ ...l, _dir: "IN" });
      for (const l of outLogs) all.push({ ...l, _dir: "OUT" });
    } catch (err) {
      console.error(`  [chunk ${cur}-${end}] ${err.message}`);
    }
    cur = end + 1;
    await sleep(CHUNK_DELAY_MS);
  }
  /*- Dedupe — a self-transfer would appear in both IN and OUT scans. */
  const seen = new Set();
  const out = [];
  for (const l of all) {
    const k = `${l.transactionHash}|${l.logIndex}|${l._dir}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  out.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? (a.logIndex || 0) - (b.logIndex || 0)
      : a.blockNumber - b.blockNumber,
  );
  return out;
}

/** Parse CLI argv. */
function parseArgs(argv) {
  const positional = [];
  let from = null;
  let to = null;
  for (const a of argv) {
    const dArg = parseDateArg(a);
    if (dArg) {
      if (dArg.kind === "from") from = dArg.date;
      else to = dArg.date;
    } else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    } else {
      positional.push(a);
    }
  }
  return { positional, from, to };
}

/** Resolve UTC date window → [fromBlock, toBlock] using head + block-time estimate. */
function dateWindowToBlocks(fromUtc, toUtc, head, headTs) {
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = fromUtc ? dateStartSec(fromUtc) : nowSec - 86400;
  const toSec = toUtc ? dateEndSec(toUtc) : nowSec;
  const fromBlock = Math.max(
    1,
    head - Math.round((headTs - fromSec) / BLOCK_TIME_SEC),
  );
  const toBlock = Math.min(
    head,
    head - Math.round((headTs - toSec) / BLOCK_TIME_SEC),
  );
  return { fromBlock, toBlock, fromSec, toSec };
}

/** Main. */
async function main() {
  const { positional, from, to } = parseArgs(process.argv.slice(2));
  if (positional.length !== 2) {
    console.error(
      "usage: node util/diagnostic/wallet-token-flow.js <wallet> <token1[,token2,...]> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]",
    );
    process.exit(1);
  }
  const wallet = ethers.getAddress(positional[0]);
  const tokens = positional[1].split(",").map((t) => ethers.getAddress(t));
  const provider = new ethers.JsonRpcProvider(config.RPC_URL);
  const head = await provider.getBlockNumber();
  const headBlock = await provider.getBlock(head);
  const headTs = Number(headBlock.timestamp);
  const { fromBlock, toBlock, fromSec, toSec } = dateWindowToBlocks(
    from,
    to,
    head,
    headTs,
  );
  console.log("=".repeat(80));
  console.log("wallet-token-flow");
  console.log(`  wallet:  ${wallet}`);
  console.log(`  tokens:  ${tokens.join(", ")}`);
  console.log(
    `  window:  ${fmtTs(fromSec)}  →  ${fmtTs(toSec)}  (blocks ${fromBlock}–${toBlock})`,
  );
  console.log(`  RPC:     ${config.RPC_URL}`);
  console.log("=".repeat(80));

  const summaries = [];
  for (const tokenAddr of tokens) {
    const erc = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    let symbol = "?";
    let decimals = 18;
    try {
      symbol = await erc.symbol();
    } catch {
      /* ignore */
    }
    try {
      decimals = Number(await erc.decimals());
    } catch {
      /* ignore */
    }
    console.log(`\n── ${symbol} @ ${tokenAddr}  (decimals=${decimals}) ──`);
    const logs = await scanToken(
      provider,
      tokenAddr,
      wallet,
      fromBlock,
      toBlock,
    );
    if (logs.length === 0) {
      console.log("  (no transfers in window)");
      summaries.push({ symbol, tokenAddr, sumIn: 0n, sumOut: 0n, decimals });
      continue;
    }
    const blocks = [...new Set(logs.map((l) => l.blockNumber))];
    const tsMap = new Map();
    for (const bn of blocks) {
      try {
        const blk = await provider.getBlock(bn);
        if (blk) tsMap.set(bn, Number(blk.timestamp));
      } catch {
        /* ignore */
      }
      await sleep(40);
    }
    let sumIn = 0n;
    let sumOut = 0n;
    console.log(
      "DIR  BLOCK     TIMESTAMP                 AMOUNT          COUNTERPARTY                                TX",
    );
    for (const l of logs) {
      const ts = tsMap.get(l.blockNumber);
      const counterparty =
        l._dir === "IN"
          ? addrFromTopic(l.topics[1])
          : addrFromTopic(l.topics[2]);
      const value = BigInt(l.data);
      if (l._dir === "IN") sumIn += value;
      else sumOut += value;
      console.log(
        `${l._dir.padEnd(4)} ${String(l.blockNumber).padEnd(9)} ${fmtTs(ts).padEnd(25)} ${fmtAmount(value, decimals).padStart(15)} ${counterparty} ${l.transactionHash}`,
      );
    }
    summaries.push({ symbol, tokenAddr, sumIn, sumOut, decimals });
  }

  console.log("\n" + "─".repeat(80));
  console.log("Net flow summary (Σ IN − Σ OUT, raw token units):");
  for (const s of summaries) {
    const net = s.sumIn - s.sumOut;
    const sign = net >= 0n ? "+" : "-";
    const mag = net < 0n ? -net : net;
    console.log(
      `  ${s.symbol.padEnd(10)}  in: ${fmtAmount(s.sumIn, s.decimals).padStart(15)}   out: ${fmtAmount(s.sumOut, s.decimals).padStart(15)}   net: ${sign}${fmtAmount(mag, s.decimals)}`,
    );
  }
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
  parseDateArg,
  dateStartSec,
  dateEndSec,
  fmtAmount,
  parseArgs,
  dateWindowToBlocks,
};
