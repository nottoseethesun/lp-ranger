#!/usr/bin/env node
/**
 * @file util/diagnostic/show-rebalance-chain.js
 * @description
 * Walks the on-chain Transfer history of the NonfungiblePositionManager
 * for a given wallet and prints every NFT mint / drain / burn that
 * touched it, in block order (oldest first).  Useful for reconstructing
 * the rebalance lineage when the dashboard's bookkeeping looks off —
 * e.g. after several rebalances and a failed TX, or when investigating
 * "where did this tokenId come from".
 *
 * What it queries:
 *   - Two parallel getLogs calls per chunk, both on
 *     config.POSITION_MANAGER:
 *       1. Transfer(*, wallet)  — every mint or transfer-in
 *       2. Transfer(wallet, *)  — every drain or transfer-out
 *   - Block timestamps for each unique block (sequential, throttled).
 *
 * What it prints (one line per Transfer):
 *   DIR  BLOCK   TIMESTAMP (UTC)        TOKENID   TXHASH  [tag]
 *   - DIR is IN  for mints / transfers-in
 *           OUT for drains / transfers-out / burns
 *   - tag is "(mint)" when from = 0x0, "(burn)" when to = 0x0
 *
 * Interpretation:
 *   - "(mint)" + "(burn)" pairs on the same tx hash within minutes →
 *     a rebalance: old NFT drained, new NFT minted.  9mm normally
 *     DRAINS (no burn) so you'll usually see "(mint)" without a
 *     matching burn — the old tokenId stays alive but with zero
 *     liquidity.
 *   - A "(mint)" with no later drain → still-live position.
 *   - Repeated IN events on the same tokenId within seconds → not
 *     real (Transfer is unique per tx); duplicates are deduped before
 *     printing.
 *
 * Read-only.  No mutations.  Safe to run while the bot is live.
 *
 * RPC behaviour:
 *   - Uses config.RPC_URL (chain default if env unset).
 *   - 10_000-block chunks with 250 ms inter-chunk throttle (matches
 *     event-scanner.js conventions to avoid endpoint saturation).
 *   - Block-time lookups: 50 ms throttle, sequential (one per block).
 *   - 5-year scan on PulseChain ≈ 1_580 chunks × ~250 ms ≈ 7 min,
 *     plus N × 50 ms for blocks containing events.  Pass a smaller
 *     yearsBack to shorten.
 *
 * Usage:
 *   node util/diagnostic/show-rebalance-chain.js <walletAddress> [yearsBack]
 *
 * Arguments:
 *   walletAddress — required, EIP-55 or lowercased 0x-prefixed 20-byte hex
 *   yearsBack     — optional, integer or float (default 5)
 *
 * Examples:
 *   node util/diagnostic/show-rebalance-chain.js \
 *       0x4e44847675763D5540B32Bee8a713CfDcb4bE61A
 *   node util/diagnostic/show-rebalance-chain.js 0x4e44... 1
 *       last 1 year only
 *   node util/diagnostic/show-rebalance-chain.js 0x4e44... 0.25
 *       last ~3 months
 *
 * Exit codes:
 *   0 — completed
 *   1 — invalid wallet address argument
 *   non-zero — RPC fatal error (printed to stderr)
 */

"use strict";

const path = require("path");

process.chdir(
  path.resolve(__dirname, "..", ".."),
); /* run from repo root for config loading */

const { ethers } = require("ethers");
const config = require("../../src/config");
const { PM_ABI } = require("../../src/pm-abi");
const { Command, InvalidArgumentError } = require("commander");
const { sleep, addrTopic, fmtTs, fetchTimestamps } = require("./_helpers");

/**
 * Accept a 0x-prefixed 20-byte wallet address, or reject it naming the
 * argument.
 *
 * Checked during parsing so a malformed address is refused before a
 * multi-minute scan starts, rather than after it.
 *
 * @param {string} value  The raw argument.
 * @returns {string}  The same value, once it is well-formed.
 * @throws {InvalidArgumentError} When it is not.
 */
function parseWallet(value) {
  if (!value.startsWith("0x") || value.length !== 42) {
    throw new InvalidArgumentError("must be a 0x-prefixed 20-byte hex address");
  }
  return value;
}

/**
 * Describe the command line, so Commander both parses it and renders
 * `--help` from the one declaration.
 *
 * Built per call rather than held at module scope, so a test can parse
 * several argument lists without state carrying between them.
 *
 * @returns {Command}  Configured, not yet parsed.
 */
function buildProgram() {
  return new Command()
    .name("show-rebalance-chain")
    .description(
      "List every NFT mint, burn and move for a wallet, by walking " +
        "position-manager Transfer events.",
    )
    .argument("<walletAddress>", "EIP-55 or lowercased hex", parseWallet)
    .argument("[yearsBack]", `how far back to scan (default ${DEFAULT_YEARS})`)
    .addHelpText(
      "after",
      "\nA five-year PulseChain scan is roughly 1,580 chunks at ~250 ms —\n" +
        "about seven minutes — plus 50 ms per block holding an event. Pass\n" +
        "a smaller yearsBack to shorten it.\n" +
        "\nExit codes:\n  0  completed\n  1  invalid arguments\n",
    );
}

/** Block time on PulseChain ≈ 10 s.  Used to estimate the start block. */
const BLOCK_TIME_SEC = 10;

/** Default lookback when not specified. */
const DEFAULT_YEARS = 5;

/** Chunk size for getLogs. */
const CHUNK_SIZE = 10000;

/** Throttle between RPC chunks (ms) — matches event-scanner.js. */
const CHUNK_DELAY_MS = 250;

const ZERO_TOPIC = "0x" + "0".repeat(64);

/** Pull tokenId out of a Transfer log topic[3]. */
function tokenIdFromLog(log) {
  try {
    return BigInt(log.topics[3]).toString();
  } catch {
    return "?";
  }
}

/** Query Transfer logs in chunks and return raw logs sorted by block. */
async function scanTransfers(provider, walletAddress, fromBlock, toBlock) {
  const iface = new ethers.Interface(PM_ABI);
  const transferTopic = iface.getEvent("Transfer").topicHash;
  const wTopic = addrTopic(walletAddress);
  const all = [];
  let cur = fromBlock;
  let chunks = 0;
  const totalChunks = Math.ceil((toBlock - fromBlock) / CHUNK_SIZE);
  while (cur <= toBlock) {
    const end = Math.min(cur + CHUNK_SIZE - 1, toBlock);
    chunks++;
    if (chunks % 25 === 0 || chunks === 1) {
      console.log(
        `  [chunk ${chunks}/${totalChunks}] blocks ${cur}–${end}` +
          `  (collected: ${all.length})`,
      );
    }
    try {
      const [inLogs, outLogs] = await Promise.all([
        provider.getLogs({
          address: config.POSITION_MANAGER,
          fromBlock: cur,
          toBlock: end,
          topics: [transferTopic, null, wTopic],
        }),
        provider.getLogs({
          address: config.POSITION_MANAGER,
          fromBlock: cur,
          toBlock: end,
          topics: [transferTopic, wTopic, null],
        }),
      ]);
      for (const l of inLogs) all.push({ ...l, _dir: "IN" });
      for (const l of outLogs) all.push({ ...l, _dir: "OUT" });
    } catch (err) {
      console.error(`  [chunk ${chunks}] error: ${err.message}`);
    }
    cur = end + 1;
    await sleep(CHUNK_DELAY_MS);
  }
  all.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? (a.transactionIndex || 0) - (b.transactionIndex || 0)
      : a.blockNumber - b.blockNumber,
  );
  return all;
}

/** Dedupe logs with the same (block, tx, tokenId, direction) tuple. */
function dedupe(logs) {
  const seen = new Set();
  const out = [];
  for (const l of logs) {
    const k =
      `${l.blockNumber}|${l.transactionHash}` +
      `|${tokenIdFromLog(l)}|${l._dir}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/**
 * Classify one Transfer log for display.
 *
 * A mint (from the zero address) and a burn (to it) are the two events
 * that bound an NFT's life, and they are what an operator is scanning
 * for — an untagged mint row is indistinguishable from an ordinary
 * inbound transfer, which is exactly the distinction the tool exists
 * to show.
 *
 * @param {object} l  Transfer log carrying its `_dir` tag.
 * @param {Map} tsMap Block number → unix seconds.
 * @returns {{dir: string, blockNumber: number, ts: number|undefined,
 *           tokenId: string, tx: string, tag: string}}
 */
function classifyTransfer(l, tsMap) {
  const fromZero = l.topics[1] === ZERO_TOPIC;
  const toZero = l.topics[2] === ZERO_TOPIC;
  let tag = "";
  if (l._dir === "IN" && fromZero) tag = " (mint)";
  else if (l._dir === "OUT" && toZero) tag = " (burn)";
  return {
    /*- Padded so IN and OUT occupy the same width in the table. */
    dir: l._dir === "IN" ? "IN " : "OUT",
    blockNumber: l.blockNumber,
    ts: tsMap.get(l.blockNumber),
    tokenId: tokenIdFromLog(l),
    tx: l.transactionHash,
    tag,
  };
}

/** Run banner: wallet, RPC, block range and the contract being read. */
function renderHeader({ wallet, rpcUrl, fromBlock, head, years, pmAddress }) {
  console.log("=".repeat(80));
  console.log(`show-rebalance-chain`);
  console.log(`  wallet:      ${wallet}`);
  console.log(`  RPC:         ${rpcUrl}`);
  console.log(`  block range: ${fromBlock} → ${head}  (~${years} year(s))`);
  console.log(`  PM address:  ${pmAddress}`);
  console.log("=".repeat(80));
  console.log("Scanning Transfer events...");
}

/** The transfer table, one row per deduped log. */
function renderTransfers(logs, tsMap) {
  console.log("\n" + "─".repeat(80));
  console.log("DIR  BLOCK       TIMESTAMP             TOKENID         TX");
  console.log("─".repeat(80));
  for (const l of logs) {
    const r = classifyTransfer(l, tsMap);
    console.log(
      `${r.dir}  ${String(r.blockNumber).padEnd(11)} ` +
        `${fmtTs(r.ts).padEnd(22)} ${r.tokenId.padEnd(15)} ` +
        `${r.tx}${r.tag}`,
    );
  }
  console.log("─".repeat(80));
  console.log("Done.");
}

/** Main. */
async function main(argv = process.argv.slice(2)) {
  const program = buildProgram().parse(argv, { from: "user" });
  const [wallet, yearsArg] = program.args;
  const years = Number(yearsArg) || DEFAULT_YEARS;
  const checksummed = ethers.getAddress(wallet);
  const provider = new ethers.JsonRpcProvider(config.RPC_URL);
  const head = await provider.getBlockNumber();
  const blocksBack = Math.round((years * 365.25 * 24 * 3600) / BLOCK_TIME_SEC);
  const fromBlock = Math.max(1, head - blocksBack);
  renderHeader({
    wallet: checksummed,
    rpcUrl: config.RPC_URL,
    fromBlock,
    head,
    years,
    pmAddress: config.POSITION_MANAGER,
  });
  const raw = await scanTransfers(provider, checksummed, fromBlock, head);
  const logs = dedupe(raw);
  console.log(
    `\nFound ${logs.length} transfer event(s) (after dedupe).` +
      "  Resolving timestamps...",
  );
  const blocks = [...new Set(logs.map((l) => l.blockNumber))];
  const tsMap = await fetchTimestamps(provider, blocks);
  renderTransfers(logs, tsMap);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

/*- scanTransfers is exported for the test suite:
 *  they own the chunked getLogs loop and the block-timestamp cache, so
 *  leaving them untested would leave the tool's core scan unverified.
 *  Both take an injected provider, so tests drive them with a double. */
module.exports = {
  tokenIdFromLog,
  dedupe,
  scanTransfers,
  classifyTransfer,
  renderHeader,
  renderTransfers,
  parseWallet,
  buildProgram,
};
