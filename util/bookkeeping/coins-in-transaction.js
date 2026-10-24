"use strict";

/**
 * @file util/bookkeeping/coins-in-transaction.js
 * @description
 * Read what one transaction moved for a wallet, for bookkeeping in coins,
 * and return it as a json object: what kind of transaction it was, the
 * position manager's liquidity events, the fees of any drain, the
 * wallet's coin transfers and approvals, and the gas paid. It is the
 * receipt-reading step of
 * `docs/util/bookkeeping-for-coins-in-transactions/engineering.md`,
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
 * this tool prints the object as json. Its configuration is LP Ranger's
 * own, from the app's resolver (src/lib/config.js), which reads the install's
 * `.env` and settings. That gives the chain, LP Ranger's own unless
 * `--blockchain <name>` names another the configuration names
 * (./blockchain.js settles it before the resolver loads); the endpoint
 * asked, the one LP Ranger tries first unless `--rpc-endpoint <url>`
 * names another; and the position manager whose events are read, unless
 * `--position-manager <address>` names another. It writes nothing, so it
 * is safe to run while LP Ranger runs. It asks that one endpoint only:
 * when the endpoint fails, the tool stops with the error and suggests
 * another, rather than moving to one itself.
 *
 * Exit status is 0 when the receipt was read and printed, and 1 when it
 * was not.
 *
 * Usage:
 *   node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address>
 *   node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address> --blockchain <name>
 *   node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address> --rpc-endpoint <url>
 */

const { Command, InvalidArgumentError } = require("commander");
const { ethers } = require("ethers");
const { parseBlockchain, oneChainNotice } = require("./blockchain");
const config = require("../../src/lib/config");
const { sameHex } = require("../../src/lib/nft-move-rules");
const { parseEndpoint } = require("../diagnostic/check-rpc-health");

/**
 * What a run that stops on an endpoint's failure tells the user to do.
 * Neither bookkeeping tool moves to another endpoint by itself.
 */
const RPC_ADVICE =
  "If the problem is the rpc endpoint, consider trying a different rpc " +
  "node with --rpc-endpoint <url>. This tool does not fail over to another.";

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

The chain, the endpoint and the position manager are LP Ranger's own, from
its configuration (.env and settings), unless an option names another. A run
reads one blockchain; when the configuration names more than one, it says so.
It reads one receipt and writes nothing, so it is safe to run while LP Ranger
runs. What each kind of transaction moves:
docs/util/bookkeeping-for-coins-in-transactions/engineering.md

Exit status: 0 when the receipt was read, 1 when it was not: a transaction
not yet mined or on another chain, or an endpoint that failed. An endpoint
that fails stops the run with its error; the tool moves to no other, so try
a different rpc node with --rpc-endpoint.
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
      "--blockchain <name>",
      "the blockchain to read, one the configuration names (default: " +
        "LP Ranger's own, pulsechain as shipped)",
      parseBlockchain,
    )
    .option(
      "--rpc-endpoint <url>",
      "the endpoint to ask (default: the one LP Ranger tries first)",
      parseEndpoint,
    )
    .option(
      "--position-manager <address>",
      "the position manager whose events to read (default: LP Ranger's)",
      parseAddress,
    )
    .addHelpText("after", HELP_AFTER);
}

/**
 * Whether two addresses are the same, whatever their letters' case, by
 * LP Ranger's own comparison (`sameHex`, src/lib/nft-move-rules.js).
 * @param {string} a  An address.
 * @param {string} b  Another address.
 * @returns {boolean}
 */
function sameAddress(a, b) {
  return sameHex(a, b);
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
 * @param {number} chainId   The chain's id, from LP Ranger's configuration.
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
 * else LP Ranger's, which its configuration always names (it refuses to
 * load without one).
 * @param {{positionManager?: string}} opts  The parsed options.
 * @returns {string}  An address.
 */
function positionManagerOf(opts) {
  return opts.positionManager === undefined
    ? config.POSITION_MANAGER
    : opts.positionManager;
}

/**
 * The endpoint a run asks: the one `--rpc-endpoint` names, else the one
 * LP Ranger tries first: an endpoint added in its Bot Settings, else
 * RPC_URL in `.env`, else the chain's first in chains.json.
 * @param {{rpcEndpoint?: string}} opts  The parsed options.
 * @returns {string}  The rpc url.
 */
function endpointOf(opts) {
  return opts.rpcEndpoint === undefined ? config.RPC_URLS[0] : opts.rpcEndpoint;
}

/**
 * Whether a run's `--blockchain` disagrees with the chain the
 * configuration loaded. From a shell it never does, since ./blockchain.js
 * read the same command line before the configuration loaded; a caller
 * that hands `main` other arguments can make it.
 * @param {{blockchain?: string}} opts  The parsed options.
 * @returns {string|null}  The refusal, or null when they agree.
 */
function blockchainMismatch(opts) {
  if (opts.blockchain === undefined || opts.blockchain === config.CHAIN_NAME)
    return null;
  return (
    `--blockchain ${opts.blockchain} came after the configuration loaded ` +
    `${config.CHAIN_NAME}; give it on the command line.`
  );
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
  const mismatch = blockchainMismatch(opts);
  if (mismatch !== null) {
    console.error(mismatch);
    process.exitCode = 1;
    return;
  }
  /*-
   *  On stderr, like every line but the record, so the json on stdout can
   *  be redirected to a file whole.
   */
  const notice = oneChainNotice(config.CHAIN_NAME);
  if (notice !== null) console.error(notice);
  const endpoint = endpointOf(opts);
  const make =
    deps.makeProvider === undefined ? makeProvider : deps.makeProvider;
  const provider = make(endpoint, config.CHAIN.chainId);
  let record;
  try {
    record = await coinsInTransaction(provider, {
      hash,
      wallet: opts.wallet,
      positionManager: positionManagerOf(opts),
    });
  } catch (error) {
    console.error(`${endpoint} failed: ${error.message}\n${RPC_ADVICE}`);
    process.exitCode = 1;
    return;
  }
  if (record === null) {
    console.error(
      `No receipt for ${hash} at ${endpoint}: it is not mined yet, ` +
        `or not on ${config.CHAIN_NAME}.`,
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
  RPC_ADVICE,
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
  endpointOf,
  blockchainMismatch,
  main,
};
