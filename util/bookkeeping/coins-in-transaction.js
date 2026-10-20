"use strict";

/**
 * @file util/bookkeeping/coins-in-transaction.js
 * @description
 * Read what one transaction moved for a wallet, for bookkeeping in coins,
 * and return it as a json object: what kind of transaction it was, the
 * position manager's liquidity events, the fees of any drain, the
 * wallet's coin transfers and approvals, and the gas paid. It is the
 * receipt-reading step of `docs/bookkeeping-for-coins-in-transactions.md`,
 * which explains what each kind of liquidity transaction moves.
 *
 * `coinsInTransaction` asks a provider for one thing, the transaction's
 * receipt, and reads its events. The position manager's
 * `IncreaseLiquidity`, `DecreaseLiquidity` and `Collect` events each give
 * both of a position's amounts, and its NFT `Transfer` events mark a mint,
 * from the zero address, and a burn, to it. When a receipt holds a drain,
 * a `DecreaseLiquidity` and a `Collect` for one NFT, the fees are the
 * `Collect` amounts less the `DecreaseLiquidity` ones. A coin's `Transfer`
 * event gives one movement of that coin and its `Approval` event an
 * allowance; the object keeps those from or to the wallet. Every amount is
 * a string of the raw digits the chain records, to be divided by 10 to the
 * power of its coin's decimals. The gas is a raw amount of the chain's own
 * coin, which has 18 decimals.
 *
 * `util/bookkeeping/coins-in-transactions-on-wallet` calls it for every
 * transaction of a wallet's rebalances and compounds. Run from a shell,
 * this tool prints the object as json. The chain is an entry of the
 * shipped `chains.json`: the app's default chain, unless `--chain <name>`
 * names another. That entry gives the endpoint asked, its first unless
 * `--rpc-endpoint <url>` names another, and the position manager whose
 * events are read, unless `--position-manager <address>` names another.
 * Like `util/diagnostic/check-rpc-health.js`, whose option parsers it
 * shares, it imports nothing from `src/` and writes nothing, so it is safe
 * to run while LP Ranger runs.
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
 * `Transfer` and `Approval`, each about one coin.
 */
const EVENTS = new ethers.Interface([
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

/** A log's first topic when it is a `Transfer`, whether a coin's or an NFT's. */
const TRANSFER_TOPIC = EVENTS.getEvent("Transfer").topicHash;

/** A log's first topic when it is an `Approval`, whether a coin's or an NFT's. */
const APPROVAL_TOPIC = EVENTS.getEvent("Approval").topicHash;

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
 * The part of `--help` printed after the list of options: each field of
 * the json object, how to read its amounts, examples and the exit status.
 */
const HELP_AFTER = `
The json object:
  hash, blockNumber  the transaction and its block
  from, to           who sent it, and the address it was sent to
  status             "succeeded" or "reverted": a reverted transaction moved
                     nothing, and still paid its gas
  kind               "reverted" for a reverted one; else "drain", "mint",
                     "deposit", "collect", "decrease" or "burn" when the
                     position manager took part; else "swap", "approval",
                     "cancel" (sent from the wallet to itself),
                     "transfer out", "transfer in" or "other"
  gasPaid            the gas paid, in the chain's own coin, raw (18 decimals)
  liquidity          the position manager's IncreaseLiquidity,
                     DecreaseLiquidity and Collect events: event, nftId,
                     amount0, amount1
  nftTransfers       NFTs minted, from the zero address, or burned, to it:
                     nftId, from, to
  fees               for a drain, each NFT's Collect less its
                     DecreaseLiquidity: nftId, amount0, amount1
  transfers          the wallet's coin transfers: coin, direction ("out" or
                     "in"), amount
  approvals          allowances the wallet gave: coin, spender, amount

  Every amount is a string of raw digits: divide it by 10 to the power of
  its coin's decimals. amount0 is the pool's token0, and amount1 its token1.

Examples:
  node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address>
  node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address> \\
       --rpc-endpoint <url>

It reads one receipt, imports nothing from src/ and writes nothing, so it is
safe to run while LP Ranger runs. What each kind of transaction moves:
docs/bookkeeping-for-coins-in-transactions.md

Exit status: 0 when the receipt was read, 1 when it was not: a transaction
not yet mined or on another chain, or an endpoint that did not answer.
`;

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
      "Print, as json, what one transaction moved for a wallet: its " +
        "kind, the position manager's liquidity events, the wallet's coin " +
        "transfers and approvals, and the gas paid. Reads the " +
        "transaction's receipt and sends nothing.",
    )
    .argument(
      "<hash>",
      "the transaction's hash: 0x and 64 hex digits",
      parseHash,
    )
    .requiredOption(
      "--wallet <address>",
      "the wallet whose coins to count (required)",
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
    .addHelpText("after", HELP_AFTER);
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
 * The address a 32-byte topic holds.
 * @param {string} topic  A log topic holding an indexed address.
 * @returns {string}  The address, EIP-55 checksummed.
 */
function topicAddress(topic) {
  return ethers.getAddress(ethers.dataSlice(topic, 12));
}

/**
 * Read one of the position manager's logs as a liquidity event.
 *
 * The three liquidity events carry two topics, the event and the NFT id.
 * Any other log of the position manager's is skipped first: its NFT
 * `Transfer` and `Approval` carry four topics, which the coin events above
 * share a first topic with but cannot decode.
 *
 * @param {{topics: string[], data: string}} log  A log of the position manager's.
 * @returns {{event: string, nftId: bigint, amount0: bigint, amount1: bigint}|null}
 *   The event, or null when the log is not a liquidity event.
 */
function liquidityEvent(log) {
  if (log.topics.length !== 2) return null;
  const parsed = EVENTS.parseLog(log);
  if (parsed === null || !LIQUIDITY_EVENTS.includes(parsed.name)) return null;
  const { tokenId, amount0, amount1 } = parsed.args;
  return { event: parsed.name, nftId: tokenId, amount0, amount1 };
}

/**
 * Read one of the position manager's logs as an NFT changing hands. A
 * mint comes from the zero address and a burn goes to it.
 *
 * @param {{topics: string[]}} log  A log of the position manager's.
 * @returns {{nftId: bigint, from: string, to: string}|null}
 *   The transfer, or null when the log is not an NFT's `Transfer`.
 */
function nftTransfer(log) {
  if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 4) return null;
  return {
    nftId: BigInt(log.topics[3]),
    from: topicAddress(log.topics[1]),
    to: topicAddress(log.topics[2]),
  };
}

/**
 * Read a log as one of the wallet's coin transfers.
 *
 * A coin's `Transfer` has three topics. One with four is an NFT changing
 * hands, which moves no coin. A transfer from the wallet to itself changes
 * nothing, so it is left out too.
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
 * Read a log as an allowance the wallet gave a contract over one coin.
 *
 * Some coins emit an `Approval` whenever a contract spends the allowance,
 * so a swap, mint or deposit can carry one too; only a transaction with
 * nothing but approvals is an approval transaction (see `walletKind`).
 *
 * @param {{address: string, topics: string[], data: string}} log  Any log.
 * @param {string} wallet  The wallet's address.
 * @returns {{coin: string, spender: string, amount: bigint}|null}
 *   The allowance, or null when the log is not one of the wallet's.
 */
function walletApproval(log, wallet) {
  if (log.topics[0] !== APPROVAL_TOPIC || log.topics.length !== 3) return null;
  const { owner, spender, value } = EVENTS.parseLog(log).args;
  if (!sameAddress(owner, wallet)) return null;
  return { coin: ethers.getAddress(log.address), spender, amount: value };
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
 * @param {Array<{event: string, nftId: bigint, amount0: bigint, amount1: bigint}>} liquidity
 *   The receipt's liquidity events.
 * @returns {Array<{nftId: bigint, amount0: bigint, amount1: bigint}>}
 */
function drainFees(liquidity) {
  const byNft = new Map();
  for (const e of liquidity) {
    const sums = byNft.get(e.nftId) ?? { decrease: null, collect: null };
    if (e.event === "DecreaseLiquidity")
      sums.decrease = addAmounts(sums.decrease, e);
    if (e.event === "Collect") sums.collect = addAmounts(sums.collect, e);
    byNft.set(e.nftId, sums);
  }
  const fees = [];
  for (const [nftId, { decrease, collect }] of byNft) {
    if (decrease === null || collect === null) continue;
    fees.push({
      nftId,
      amount0: collect.amount0 - decrease.amount0,
      amount1: collect.amount1 - decrease.amount1,
    });
  }
  return fees;
}

/**
 * The kind of a transaction that called the position manager, from its
 * liquidity events and NFT transfers.
 *
 * @param {Array<{event: string}>} liquidity  Its liquidity events.
 * @param {Array<{from: string, to: string}>} nfts  Its NFT transfers.
 * @returns {string|null}  "drain", "mint", "deposit", "collect",
 *   "decrease" or "burn", or null when the position manager did nothing.
 */
function liquidityKind(liquidity, nfts) {
  const has = (name) => liquidity.some((e) => e.event === name);
  if (has("DecreaseLiquidity") && has("Collect")) return "drain";
  if (has("IncreaseLiquidity")) {
    const minted = nfts.some((t) => t.from === ethers.ZeroAddress);
    return minted ? "mint" : "deposit";
  }
  if (has("Collect")) return "collect";
  if (has("DecreaseLiquidity")) return "decrease";
  if (nfts.some((t) => t.to === ethers.ZeroAddress)) return "burn";
  return null;
}

/**
 * The kind of a transaction the position manager took no part in, from
 * what it did to the wallet.
 *
 * @param {{from: string, to: string|null, transfers: object[], approvals: object[]}} parts
 * @returns {string}  "cancel" (sent from the wallet to itself), "swap"
 *   (one coin out, another in), "transfer out", "transfer in",
 *   "approval" or "other".
 */
function walletKind({ from, to, transfers, approvals }) {
  if (to !== null && sameAddress(from, to)) return "cancel";
  const out = transfers.some((t) => t.direction === "out");
  const into = transfers.some((t) => t.direction === "in");
  if (out && into) return "swap";
  if (out) return "transfer out";
  if (into) return "transfer in";
  if (approvals.length > 0) return "approval";
  return "other";
}

/**
 * Turn an object's bigint values into strings of their digits, so that
 * json can carry them exactly.
 * @param {object} item  An object whose values are bigints or strings.
 * @returns {object}
 */
function digits(item) {
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    out[key] = typeof value === "bigint" ? String(value) : value;
  }
  return out;
}

/**
 * Read a receipt into the json object this tool returns.
 *
 * @param {object} receipt  An ethers transaction receipt.
 * @param {{wallet: string, positionManager: string}} who
 *   The wallet's and the position manager's addresses.
 * @returns {object}  The transaction's record, every amount a string.
 */
function readReceipt(receipt, { wallet, positionManager }) {
  const liquidity = [];
  const nfts = [];
  const transfers = [];
  const approvals = [];
  for (const log of receipt.logs) {
    if (sameAddress(log.address, positionManager)) {
      const event = liquidityEvent(log);
      if (event !== null) liquidity.push(event);
      const nft = nftTransfer(log);
      if (nft !== null) nfts.push(nft);
      continue;
    }
    const transfer = walletTransfer(log, wallet);
    if (transfer !== null) transfers.push(transfer);
    const approval = walletApproval(log, wallet);
    if (approval !== null) approvals.push(approval);
  }
  const reverted = receipt.status !== 1;
  const kind = reverted
    ? "reverted"
    : (liquidityKind(liquidity, nfts) ??
      walletKind({ from: receipt.from, to: receipt.to, transfers, approvals }));
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    from: receipt.from,
    to: receipt.to,
    status: reverted ? "reverted" : "succeeded",
    kind,
    /*-
     *  ethers names the receipt's effectiveGasPrice `gasPrice`: the price
     *  this transaction paid for each unit of gas.
     */
    gasPaid: String(receipt.gasUsed * receipt.gasPrice),
    liquidity: liquidity.map(digits),
    nftTransfers: nfts.map(digits),
    fees: drainFees(liquidity).map(digits),
    transfers: transfers.map(digits),
    approvals: approvals.map(digits),
  };
}

/**
 * Read one transaction's record: ask the provider for its receipt, and
 * read that.
 *
 * @param {{getTransactionReceipt: Function}} provider  Where to ask.
 * @param {{hash: string, wallet: string, positionManager: string}} what
 *   The transaction, and the wallet and position manager to read it for.
 * @returns {Promise<object|null>}  The record, or null when the endpoint
 *   has no receipt: a transaction not yet mined, or on another chain.
 */
async function coinsInTransaction(provider, { hash, wallet, positionManager }) {
  const receipt = await provider.getTransactionReceipt(hash);
  if (receipt === null) return null;
  return readReceipt(receipt, { wallet, positionManager });
}

/**
 * Make the provider receipts are asked of: one endpoint, told its chain
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
 * The position manager a run reads: the one `--position-manager` names,
 * else the chain's in chains.json, which may be empty.
 * @param {{positionManager?: string}} opts  The parsed options.
 * @param {object} chain  The chain's chains.json entry.
 * @returns {string}  An address, or "" when chains.json names none.
 */
function positionManagerOf(opts, chain) {
  return opts.positionManager === undefined
    ? chain.contracts.positionManager.address
    : opts.positionManager;
}

/**
 * Parse the arguments, read the receipt, print its record as json, and
 * set the exit status.
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
  const positionManager = positionManagerOf(opts, chain);
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
  const record = await coinsInTransaction(provider, {
    hash,
    wallet: opts.wallet,
    positionManager,
  });
  if (record === null) {
    console.error(
      `No receipt for ${hash} at ${endpoint}: it is not mined yet, ` +
        `or not on ${opts.chain}.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(record, null, 2));
  process.exitCode = 0;
}

/*-
 *  Gated so requiring this file from a test, or from the wallet report
 *  that calls coinsInTransaction, does not ask an endpoint for a receipt,
 *  the same arrangement every tool under util/ uses.
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
  sameAddress,
  liquidityEvent,
  nftTransfer,
  walletTransfer,
  walletApproval,
  drainFees,
  liquidityKind,
  walletKind,
  readReceipt,
  coinsInTransaction,
  makeProvider,
  positionManagerOf,
  main,
};
