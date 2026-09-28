#!/usr/bin/env node
/**
 * @file util/diagnostic/wallet-token-flow/index.js
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
 *   DIR  BLOCK     TIMESTAMP (UTC)        AMOUNT          SYMBOL
 *   COUNTERPARTY  TX
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
 *   node util/diagnostic/wallet-token-flow <wallet> \
 *       <token>[,token2,...] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *
 * Arguments:
 *   wallet      — 20-byte hex, EIP-55 or lowercase
 *   token list  — comma-separated 20-byte hex token addresses
 *   --from=DATE — UTC start date (inclusive).  Default: 24 h before head.
 *   --to=DATE   — UTC end date   (inclusive).  Default: now.
 *
 * Examples:
 *   # Today's WPLS + PLSX flow on the wallet
 *   node util/diagnostic/wallet-token-flow \
 *     0x4e44847675763D5540B32Bee8a713CfDcb4bE61A \
 *     0xA1077a294dDE1B09bB078844df40758a5D0f9a27,\
 *       0x95B303987A60C71504D99Aa1b13B4DA07b0790ab \
 *     --from=2026-04-28 --to=2026-04-28
 *
 *   # Last 24 hours, defaults
 *   node util/diagnostic/wallet-token-flow 0x4e44... 0xA1077a...
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
const config = require("../../../src/config");
const helpers = require("../_helpers");
const { Command, InvalidArgumentError } = require("commander");

const render = require("./render");

/*- `fmtTs` moved with the report text into the render module; this
 *  file no longer formats anything for the screen. */
const { sleep, addrTopic, fetchTimestamps } = helpers;
const addrFromTopic = (t) => helpers.addrFromTopic(t, ethers);

const BLOCK_TIME_SEC = 10;
const CHUNK_SIZE = 10000;
const CHUNK_DELAY_MS = 250;

/*- Between per-block timestamp lookups.  Shorter than CHUNK_DELAY_MS:
 *  a single getBlock is far cheaper than a block-range getLogs. */
const TS_DELAY_MS = 40;

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

/**
 * Accept a `--from`/`--to` value, or reject it naming the option.
 *
 * Checked during parsing so a malformed date is refused before any
 * block-range arithmetic, which would otherwise turn it into a
 * nonsensical window rather than an error.
 *
 * @param {string} value  The raw option value.
 * @returns {string}  The same value, once it is `YYYY-MM-DD`.
 * @throws {InvalidArgumentError} When it is not.
 */
function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidArgumentError("expected YYYY-MM-DD");
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
    .name("wallet-token-flow")
    .description(
      "List ERC-20 Transfer events for a wallet over a UTC date window, " +
        "with a net-flow summary.\n\nThe window becomes a block range via " +
        "head plus a per-block time estimate, so it is approximate by a " +
        "few minutes — fine for reading, not for accounting.",
    )
    .argument("<wallet>", "20-byte hex, EIP-55 or lowercase")
    .argument("<tokens>", "comma-separated 20-byte hex token addresses")
    .option(
      "--from <date>",
      "UTC start, inclusive (default: 24 h ago)",
      parseDate,
    )
    .option("--to <date>", "UTC end, inclusive (default: now)", parseDate)
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  wallet-token-flow 0x4e44... 0xA1077a...\n" +
        "  wallet-token-flow 0x4e44... 0xA1077a...,0x95B303... \\\n" +
        "      --from 2026-04-28 --to 2026-04-28\n" +
        "\nExit codes:\n  0  completed\n  1  bad arguments\n",
    );
}

/**
 * Resolve UTC date window → [fromBlock, toBlock] using head + block-time
 * estimate.
 */
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

/**
 * Read a token's symbol and decimals, tolerating contracts that answer
 * neither.
 *
 * Both lookups fall back rather than abort: a token with a non-standard
 * (or missing) `symbol()` is still worth scanning, and a wrong label on
 * a row is a far smaller loss than refusing to report the transfers.
 * The 18-decimal default is the ERC-20 convention.
 *
 * @param {object} provider   Injected RPC provider.
 * @param {string} tokenAddr
 * @returns {Promise<{symbol: string, decimals: number}>}
 */
async function readTokenMeta(provider, tokenAddr) {
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
  return { symbol, decimals };
}

/**
 * Turn raw Transfer logs into display rows and running totals.
 *
 * Pure: takes the timestamp map the caller already resolved and does
 * no I/O, so the direction/counterparty/amount decoding — the part
 * that is easy to get subtly wrong — is directly assertable.
 *
 * @param {object[]} logs   Logs from `scanToken`, carrying `_dir`.
 * @param {Map} tsMap       Block number → unix seconds.
 * @returns {{rows: object[], sumIn: bigint, sumOut: bigint}}
 */
function buildTransferRows(logs, tsMap) {
  let sumIn = 0n;
  let sumOut = 0n;
  const rows = [];
  for (const l of logs) {
    /*- Transfer(from indexed, to indexed, value): topic[1] is the
     *  sender and topic[2] the recipient.  For an inbound transfer the
     *  counterparty is therefore the FROM side, and vice versa. */
    const counterparty =
      l._dir === "IN" ? addrFromTopic(l.topics[1]) : addrFromTopic(l.topics[2]);
    const amount = BigInt(l.data);
    if (l._dir === "IN") sumIn += amount;
    else sumOut += amount;
    rows.push({
      dir: l._dir,
      blockNumber: l.blockNumber,
      ts: tsMap.get(l.blockNumber),
      amount,
      counterparty,
      tx: l.transactionHash,
    });
  }
  return { rows, sumIn, sumOut };
}

/**
 * Scan one token and print its section.
 *
 * @param {object} provider
 * @param {string} tokenAddr
 * @param {string} wallet
 * @param {number} fromBlock
 * @param {number} toBlock
 * @param {Function} [scan]  Log scanner; injected for tests.
 * @returns {Promise<object>} Summary row for the closing table.
 */
async function reportToken(
  provider,
  tokenAddr,
  wallet,
  fromBlock,
  toBlock,
  scan = scanToken,
) {
  const { symbol, decimals } = await readTokenMeta(provider, tokenAddr);
  render.renderTokenHeading(symbol, tokenAddr, decimals);
  const logs = await scan(provider, tokenAddr, wallet, fromBlock, toBlock);
  if (logs.length === 0) {
    render.renderNoTransfers();
    return { symbol, tokenAddr, sumIn: 0n, sumOut: 0n, decimals };
  }
  const blocks = [...new Set(logs.map((l) => l.blockNumber))];
  const tsMap = await fetchTimestamps(provider, blocks, TS_DELAY_MS);
  const { rows, sumIn, sumOut } = buildTransferRows(logs, tsMap);
  render.renderTransferTableHeader();
  for (const row of rows) render.renderTransferRow(row, fmtAmount, decimals);
  return { symbol, tokenAddr, sumIn, sumOut, decimals };
}

/** Main. */
async function main(argv = process.argv.slice(2)) {
  const program = buildProgram().parse(argv, { from: "user" });
  const positional = program.args;
  const { from = null, to = null } = program.opts();
  if (positional.length !== 2) {
    console.error(program.helpInformation());
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
  render.renderHeader({
    wallet,
    tokens,
    fromSec,
    toSec,
    fromBlock,
    toBlock,
    rpcUrl: config.RPC_URL,
  });

  const summaries = [];
  for (const tokenAddr of tokens) {
    summaries.push(
      await reportToken(provider, tokenAddr, wallet, fromBlock, toBlock),
    );
  }
  render.renderSummary(summaries, fmtAmount);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

/*- scanToken is exported for the test suite: it owns the chunked
 *  getLogs loop over both Transfer directions, which is the tool's
 *  core scan.  It takes an injected provider, so tests drive it with a
 *  double rather than the network. */
module.exports = {
  parseDateArg,
  parseDate,
  buildProgram,
  dateStartSec,
  dateEndSec,
  fmtAmount,
  dateWindowToBlocks,
  scanToken,
  readTokenMeta,
  buildTransferRows,
  reportToken,
};
