"use strict";

/**
 * @file util/bookkeeping/coins-in-transaction.js
 * @description
 * Print what one transaction moved for a wallet, for bookkeeping in
 * coins: the position manager's liquidity events, the wallet's coin
 * transfers out and in, and the gas the transaction paid. It is the
 * receipt-reading step of `docs/bookkeeping-for-coins-in-transactions.md`,
 * which explains what each kind of liquidity transaction moves and where
 * LP Ranger's own files already record it.
 *
 * It asks one rpc endpoint for one thing, the transaction's receipt, and
 * reads two kinds of event from it. The position manager's
 * `IncreaseLiquidity`, `DecreaseLiquidity` and `Collect` events each give
 * both of a position's amounts. When a receipt holds a drain, a
 * `DecreaseLiquidity` and a `Collect` for one NFT, the fees are the
 * `Collect` amounts less the `DecreaseLiquidity` ones, and the tool
 * prints them too. A coin's `Transfer` event gives one movement of that
 * coin, and the tool keeps those from or to the wallet. Every amount
 * prints raw, as the chain records it, to be divided by 10 to the power
 * of its coin's decimals. The gas prints in the chain's own coin.
 *
 * The chain is an entry of the shipped `chains.json`: the app's default
 * chain, unless `--chain <name>` names another. That entry gives the
 * endpoint asked, its first unless `--rpc-endpoint <url>` names another,
 * and the position manager whose events are read, unless
 * `--position-manager <address>` names another. Like
 * `util/diagnostic/check-rpc-health.js`, whose option parsers it shares,
 * it imports nothing from `src/` and writes nothing, so it is safe to run
 * while LP Ranger runs.
 *
 * Exit status is 0 when the receipt was read and printed, and 1 when it
 * was not.
 *
 * Usage:
 *   node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address>
 *   node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address> --chain <chains.json entry>
 *   node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address> --rpc-endpoint <url>
 */

const { Command, InvalidArgumentError } = require("commander");
const { ethers } = require("ethers");
const CHAINS = require("../../app-config/app-defaults-for-user-configurable/chains.json");
const {
  DEFAULT_CHAIN,
  defaultEndpoint,
  parseChain,
  parseEndpoint,
} = require("../diagnostic/check-rpc-health");

/**
 * The events read from a receipt: the position manager's three liquidity
 * events, each carrying both of a position's amounts, and a coin's
 * `Transfer`, carrying one movement of one coin.
 */
const EVENTS = new ethers.Interface([
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** A log's first topic when it is a `Transfer`, whether a coin's or an NFT's. */
const TRANSFER_TOPIC = EVENTS.getEvent("Transfer").topicHash;

/** The position manager's events this tool reads. */
const LIQUIDITY_EVENTS = ["IncreaseLiquidity", "DecreaseLiquidity", "Collect"];

/**
 * Accept a transaction hash, or reject it naming the argument.
 * @param {string} value  The raw argument.
 * @returns {string}  The same value, once it is 0x and 64 hex digits.
 * @throws {InvalidArgumentError} When it is not.
 */
function parseHash(value) {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value;
  throw new InvalidArgumentError(`not a transaction hash: ${value}`);
}

/**
 * Accept an address, or reject it naming the option.
 * @param {string} value  The raw option value.
 * @returns {string}  The address, EIP-55 checksummed.
 * @throws {InvalidArgumentError} When it is not an address.
 */
function parseAddress(value) {
  if (ethers.isAddress(value)) return ethers.getAddress(value);
  throw new InvalidArgumentError(`not an address: ${value}`);
}

/**
 * Describe the command line, so Commander both parses it and renders
 * `--help` from the same declaration.
 *
 * Built fresh per call, so a test can parse several argument lists
 * without options accumulating between them.
 *
 * @returns {Command}  Configured, not yet parsed.
 */
function buildProgram() {
  return new Command()
    .name("coins-in-transaction")
    .description(
      "Print what one transaction moved for a wallet: the position " +
        "manager's liquidity events, the wallet's coin transfers out and " +
        "in, and the gas paid. Reads the transaction's receipt and sends " +
        "nothing.",
    )
    .argument("<hash>", "the transaction's hash", parseHash)
    .requiredOption(
      "--wallet <address>",
      "the wallet whose coins to count",
      parseAddress,
    )
    .option(
      "--chain <name>",
      "an entry of chains.json",
      parseChain,
      DEFAULT_CHAIN,
    )
    .option(
      "--rpc-endpoint <url>",
      "the endpoint to ask (default: the chain's first in chains.json)",
      parseEndpoint,
    )
    .option(
      "--position-manager <address>",
      "the position manager whose events to read (default: the chain's, " +
        "from chains.json)",
      parseAddress,
    )
    .addHelpText(
      "after",
      "\nAmounts print raw: divide each by 10 to the power of its coin's " +
        "decimals.\nWhat each kind of transaction moves: " +
        "docs/bookkeeping-for-coins-in-transactions.md\n\n" +
        "Exit status: 0 when the receipt was read, 1 when it was not.",
    );
}

/**
 * Whether two addresses are the same, whatever their letters' case.
 * @param {string} a  An address.
 * @param {string} b  Another address.
 * @returns {boolean}
 */
function sameAddress(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Read one of the position manager's logs as a liquidity event.
 *
 * Its `Transfer` logs are skipped first: they move NFTs, not coins, and
 * carry the NFT id as a fourth topic that the coin `Transfer` above
 * cannot decode.
 *
 * @param {{topics: string[], data: string}} log  A log of the position manager's.
 * @returns {{name: string, tokenId: bigint, amount0: bigint, amount1: bigint}|null}
 *   The event, or null when the log is not a liquidity event.
 */
function liquidityEvent(log) {
  if (log.topics[0] === TRANSFER_TOPIC) return null;
  const parsed = EVENTS.parseLog(log);
  if (parsed === null || !LIQUIDITY_EVENTS.includes(parsed.name)) return null;
  const { tokenId, amount0, amount1 } = parsed.args;
  return { name: parsed.name, tokenId, amount0, amount1 };
}

/**
 * Read a log as one of the wallet's coin transfers.
 *
 * A coin's `Transfer` has three topics. One with four is an NFT changing
 * hands, which moves no coin. A transfer from the wallet to itself
 * changes nothing, so it is left out too.
 *
 * @param {{address: string, topics: string[], data: string}} log  Any log.
 * @param {string} wallet  The wallet's address.
 * @returns {{coin: string, direction: string, amount: bigint}|null}
 *   The transfer, `direction` "out" or "in", or null when the log is not
 *   one of the wallet's coin transfers.
 */
function walletTransfer(log, wallet) {
  if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) return null;
  const { from, to, value } = EVENTS.parseLog(log).args;
  const out = sameAddress(from, wallet);
  const into = sameAddress(to, wallet);
  if (out === into) return null;
  return {
    coin: ethers.getAddress(log.address),
    direction: out ? "out" : "in",
    amount: value,
  };
}

/**
 * Add one event's amounts to a running pair.
 * @param {{amount0: bigint, amount1: bigint}|null} sum  The pair so far, or null.
 * @param {{amount0: bigint, amount1: bigint}} event  The event to add.
 * @returns {{amount0: bigint, amount1: bigint}}
 */
function addAmounts(sum, event) {
  if (sum === null) return { amount0: event.amount0, amount1: event.amount1 };
  return {
    amount0: sum.amount0 + event.amount0,
    amount1: sum.amount1 + event.amount1,
  };
}

/**
 * The fees in each drain a receipt holds.
 *
 * A drain's `DecreaseLiquidity` gives the principal and its `Collect` the
 * principal plus the fees, so for an NFT with both, the fees are the
 * `Collect` amounts less the `DecreaseLiquidity` ones. These are the fees
 * the NFT earned since it last collected.
 *
 * @param {Array<{name: string, tokenId: bigint, amount0: bigint, amount1: bigint}>} liquidity
 *   The receipt's liquidity events.
 * @returns {Array<{tokenId: string, fee0: bigint, fee1: bigint}>}
 */
function drainFees(liquidity) {
  const byNft = new Map();
  for (const event of liquidity) {
    const tokenId = String(event.tokenId);
    const sums = byNft.get(tokenId) ?? { decrease: null, collect: null };
    if (event.name === "DecreaseLiquidity")
      sums.decrease = addAmounts(sums.decrease, event);
    if (event.name === "Collect")
      sums.collect = addAmounts(sums.collect, event);
    byNft.set(tokenId, sums);
  }
  const fees = [];
  for (const [tokenId, { decrease, collect }] of byNft) {
    if (decrease === null || collect === null) continue;
    fees.push({
      tokenId,
      fee0: collect.amount0 - decrease.amount0,
      fee1: collect.amount1 - decrease.amount1,
    });
  }
  return fees;
}

/**
 * Read the parts of a bookkeeping record from a receipt: what it says
 * the position manager did, which coins left and entered the wallet, and
 * the gas paid.
 *
 * @param {object} receipt  An ethers transaction receipt.
 * @param {{wallet: string, positionManager: string}} who
 *   The wallet's and the position manager's addresses.
 * @returns {{status: number, blockNumber: number, to: string|null,
 *   gasPaid: bigint, liquidity: object[], transfers: object[],
 *   fees: object[]}}
 */
function readReceipt(receipt, { wallet, positionManager }) {
  const liquidity = [];
  const transfers = [];
  for (const log of receipt.logs) {
    if (sameAddress(log.address, positionManager)) {
      const event = liquidityEvent(log);
      if (event !== null) liquidity.push(event);
    } else {
      const transfer = walletTransfer(log, wallet);
      if (transfer !== null) transfers.push(transfer);
    }
  }
  return {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    to: receipt.to,
    /*-
     *  ethers names the receipt's effectiveGasPrice `gasPrice`: the price
     *  this transaction paid for each unit of gas.
     */
    gasPaid: receipt.gasUsed * receipt.gasPrice,
    liquidity,
    transfers,
    fees: drainFees(liquidity),
  };
}

/**
 * Print a record, raw amounts and all.
 *
 * A reverted transaction moved nothing, so only its gas is printed. Any
 * other prints the position manager's events, the fees of any drain, and
 * the wallet's coin transfers, saying "none" where a list is empty so
 * that an empty list is never mistaken for a missing one.
 *
 * @param {ReturnType<typeof readReceipt>} record  What `readReceipt` read.
 * @param {{hash: string, chainName: string, nativeSymbol: string}} where
 *   The transaction's hash, its chain, and that chain's own coin.
 */
function report(record, { hash, chainName, nativeSymbol }) {
  console.log(
    `Transaction ${hash} on ${chainName}, block ${record.blockNumber}, ` +
      `sent to ${record.to}`,
  );
  console.log(
    `Gas paid: ${ethers.formatEther(record.gasPaid)} ${nativeSymbol}`,
  );
  if (record.status !== 1) {
    console.log("Status: reverted. It moved no coins and paid only its gas.");
    return;
  }
  console.log("Status: succeeded");
  console.log("");
  console.log("The position manager's events (raw amounts):");
  if (record.liquidity.length === 0) console.log("  none");
  for (const e of record.liquidity) {
    console.log(
      `  ${e.name} NFT #${e.tokenId}: amount0 ${e.amount0}, amount1 ${e.amount1}`,
    );
  }
  for (const f of record.fees) {
    console.log(
      `  Fees in NFT #${f.tokenId}'s Collect: amount0 ${f.fee0}, amount1 ${f.fee1}`,
    );
  }
  console.log("");
  console.log("The wallet's coin transfers (raw amounts):");
  if (record.transfers.length === 0) console.log("  none");
  for (const t of record.transfers) {
    console.log(`  ${t.direction}: ${t.amount} of coin ${t.coin}`);
  }
  console.log("");
  console.log(
    "Divide each raw amount by 10 to the power of its coin's decimals.",
  );
}

/**
 * Make the provider the receipt is asked of: one endpoint, told its chain
 * up front, so that no request goes to asking the endpoint which chain it
 * serves.
 *
 * @param {string} endpoint  The rpc url.
 * @param {number} chainId   The chain's id, from chains.json.
 * @returns {ethers.JsonRpcProvider}
 */
function makeProvider(endpoint, chainId) {
  const network = ethers.Network.from(chainId);
  return new ethers.JsonRpcProvider(endpoint, network, {
    staticNetwork: network,
  });
}

/**
 * Parse the arguments, read the receipt, print it, and set the exit
 * status.
 *
 * @param {string[]} [argv]  Arguments after the node/script pair.
 * @param {{makeProvider?: Function}} [deps]  How to make the provider;
 *   tests pass a stand-in that answers without a network.
 * @returns {Promise<void>}
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  /*-
   *  `from: "user"` because argv is already stripped of the node and
   *  script entries. Commander handles --help and -h itself, printing to
   *  stdout and exiting 0, and refuses a bad argument with a message
   *  naming it.
   */
  const program = buildProgram().parse(argv, { from: "user" });
  const [hash] = program.processedArgs;
  const opts = program.opts();
  const chain = CHAINS[opts.chain];
  const positionManager =
    opts.positionManager === undefined
      ? chain.contracts.positionManager.address
      : opts.positionManager;
  if (positionManager === "") {
    console.error(
      `chains.json names no position manager for ${opts.chain}: ` +
        "pass --position-manager <address>",
    );
    process.exitCode = 1;
    return;
  }
  const endpoint =
    opts.rpcEndpoint === undefined
      ? defaultEndpoint(opts.chain)
      : opts.rpcEndpoint;
  const make =
    deps.makeProvider === undefined ? makeProvider : deps.makeProvider;
  const provider = make(endpoint, chain.chainId);
  const receipt = await provider.getTransactionReceipt(hash);
  if (receipt === null) {
    console.error(
      `No receipt for ${hash} at ${endpoint}: it is not mined yet, ` +
        `or not on ${opts.chain}.`,
    );
    process.exitCode = 1;
    return;
  }
  const record = readReceipt(receipt, { wallet: opts.wallet, positionManager });
  report(record, {
    hash,
    chainName: opts.chain,
    nativeSymbol: chain.nativeCurrencySymbol,
  });
  process.exitCode = 0;
}

/*-
 *  Gated so requiring this file from a test does not ask an endpoint for
 *  a receipt, the same arrangement every tool under util/ uses.
 */
if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  EVENTS,
  parseHash,
  parseAddress,
  buildProgram,
  liquidityEvent,
  walletTransfer,
  drainFees,
  readReceipt,
  report,
  makeProvider,
  main,
};
