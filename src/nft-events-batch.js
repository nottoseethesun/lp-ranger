"use strict";

/**
 * @file src/nft-events-batch.js
 * @module nft-events-batch
 *
 * Fetches `IncreaseLiquidity` / `Collect` / `DecreaseLiquidity` history
 * for a WHOLE chain of NFTs in one pass, instead of one pass per NFT.
 *
 * ## Why
 *
 * `scanNftEvents` in `src/compounder.js` pins its filter to a single
 * token (`topics: [topicHash, tidHex]`), so a caller walking a chain
 * runs it once per NFT. Each NFT is scanned from its own mint block to
 * the chain head, so the windows overlap almost completely — the oldest
 * NFT covers the pool's whole life and every younger one re-reads
 * blocks its elders already read. On a 132-rebalance chain that is
 * ~53,000 paced requests, hours of wall clock.
 *
 * `tokenId` is the first **indexed** parameter on all three events, and
 * a JSON-RPC topic slot accepts an array of values matched as OR. One
 * filter can therefore carry the entire chain, collapsing those
 * overlapping passes into a single sweep of their union: three event
 * types over the union range, ~510 requests for the same chain.
 *
 * The node does the filtering. This is not "fetch more and discard" —
 * the same logs come back, in one response set rather than 133.
 *
 * ## The contract that makes it safe
 *
 * Batching moves the token identity from the *request* to the
 * *response*: today a result set is implicitly labelled by the id the
 * caller asked about, whereas here the logs arrive interleaved and are
 * partitioned by `topics[1]`. Two rules keep that sound:
 *
 * 1. **Every requested id gets an entry**, with empty arrays when it
 *    genuinely has no events. A caller that reads a missing key as
 *    "no events" would silently lose an NFT's history; `eventsFor`
 *    throws instead, so a lookup that was never prepared with the right
 *    query fails loudly rather than returning a plausible zero.
 * 2. **Each NFT's logs are re-floored to its own mint block.** The
 *    union range starts at the earliest floor in the set, which is
 *    below most NFTs' own floors. Filtering per id afterwards makes the
 *    batched result identical to what the per-NFT scans returned, so
 *    this is an optimisation and not a change in meaning.
 *
 * The head block is resolved ONCE for the whole batch, so every NFT and
 * every event type covers exactly the same range. The per-NFT path
 * already resolved it once per event type for the same reason.
 */

const { scanChunked } = require("./get-logs-chunked");
const { nftScanFrom } = require("./nft-mint-blocks");

/*- Token ids per filter.
 *
 *  All three shipped PulseChain endpoints accept a 132-value topic
 *  array over a 9,000-block window, but that is an observation about
 *  today's endpoints, not a guarantee in the JSON-RPC spec — an
 *  operator's own node may cap it. Chunking the id list keeps the win
 *  (a chain of any length costs ceil(n/100) passes, not n) while
 *  bounding the blast radius if a node refuses a long array. */
const ID_BATCH_SIZE = 100;

/** The three events this module fetches, in a fixed order. */
const EVENT_NAMES = ["IncreaseLiquidity", "Collect", "DecreaseLiquidity"];

/**
 * A token id as a 32-byte topic word.
 *
 * @param {string|number|bigint} tokenId
 * @returns {string}  0x-prefixed, 64 hex characters.
 */
function topicForTokenId(tokenId) {
  return "0x" + BigInt(tokenId).toString(16).padStart(64, "0");
}

/**
 * Recover the token id a log belongs to.
 *
 * Reads `topics[1]` — the indexed `tokenId` — rather than decoding the
 * whole log, so partitioning cannot depend on the ABI being right about
 * the unindexed fields.
 *
 * @param {{topics: string[]}} log
 * @returns {string|null}  Decimal id, or null when the log has no
 *   second topic (not one of ours).
 */
function tokenIdOfLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length < 2) return null;
  try {
    return BigInt(log.topics[1]).toString(10);
  } catch {
    return null;
  }
}

/*- Split a list into fixed-size groups. */
function _chunkIds(ids, size) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Per-id scan floor for every id in the set, and the union floor.
 *
 * Each id keeps its own floor — that is what the batched result is
 * filtered back to — while the single request covers from the lowest of
 * them. `nftScanFrom` owns how a mint block and a shared floor combine
 * (`Math.max`, so a resume checkpoint beats an earlier mint block); see
 * docs/engineering.md § "Per-NFT Scan Windows".
 *
 * @param {string[]} tokenIds
 * @param {Map<string, number>|object} mintBlocks  tokenId -> mint block.
 * @param {number} sharedFloor  Pool creation block, or a resume
 *   checkpoint on an incremental rescan.
 * @returns {{floors: Map<string, number>, unionFrom: number}}
 */
function scanFloors(tokenIds, mintBlocks, sharedFloor) {
  const floors = new Map();
  let unionFrom = null;
  for (const id of tokenIds) {
    const from = nftScanFrom(mintBlocks, id, sharedFloor);
    floors.set(String(id), from);
    if (unionFrom === null || from < unionFrom) unionFrom = from;
  }
  return { floors, unionFrom: unionFrom === null ? sharedFloor : unionFrom };
}

/**
 * Empty result shape, so every requested id has a real entry.
 *
 * @returns {{ilEvents: object[], collectEvents: object[], dlEvents: object[], ilLogsCount: number}}
 */
function emptyEvents() {
  return { ilEvents: [], collectEvents: [], dlEvents: [], ilLogsCount: 0 };
}

/*- Run one chunked scan for a single (event type, id-group) pair. */
async function _scanGroup(o, name, idsHex) {
  return scanChunked({
    provider: o.provider,
    fromBlock: o.fromBlock,
    toBlock: o.toBlock,
    chunkSize: o.chunkSize,
    label: `nft-batch ${name} x${idsHex.length}`,
    query: (f, t) =>
      o.provider.getLogs({
        address: o.address,
        fromBlock: f,
        toBlock: t,
        topics: [o.iface.getEvent(name).topicHash, idsHex],
      }),
  });
}

/*- Drop logs that fall below the id's OWN floor.
 *
 *  The single request covers from the lowest floor in the set, which is
 *  below most ids' floors. Re-flooring here is what makes the batched
 *  result identical to the per-NFT scans it replaces. */
function _keepAtOrAbove(logs, floors) {
  const out = new Map();
  for (const log of logs) {
    const id = tokenIdOfLog(log);
    if (id === null) continue;
    const floor = floors.get(id);
    if (floor === undefined) continue;
    if (typeof log.blockNumber === "number" && log.blockNumber < floor)
      continue;
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(log);
  }
  return out;
}

/**
 * Fetch the three event histories for a whole chain of NFTs at once.
 *
 * @param {object} o
 * @param {string[]} o.tokenIds     Every NFT in the chain. Must be non-empty.
 * @param {Map|object} o.mintBlocks tokenId -> mint block.
 * @param {number} o.sharedFloor    Pool floor, or resume checkpoint.
 * @param {object} o.provider       ethers provider.
 * @param {object} o.iface          ethers Interface carrying the three events.
 * @param {string} o.address        NonfungiblePositionManager address.
 * @param {number} [o.toBlock]      Head block. Resolved once when absent,
 *   so every id and event type covers an identical range.
 * @param {number} [o.chunkSize]    Block-window width.
 * @param {Function} [o.parseLogs]  (iface, logs) -> decoded events.
 * @returns {Promise<Map<string, object>>}  One entry per requested id.
 */
async function fetchChainNftEvents(o) {
  const ids = (o.tokenIds || []).map(String);
  if (ids.length === 0) return new Map();
  const { floors, unionFrom } = scanFloors(ids, o.mintBlocks, o.sharedFloor);
  const head =
    typeof o.toBlock === "number"
      ? o.toBlock
      : await o.provider.getBlockNumber();
  const groups = _chunkIds(ids.map(topicForTokenId), ID_BATCH_SIZE);

  /*- Result skeleton FIRST, so every requested id has an entry even if
   *  the scans return nothing for it. A missing key would otherwise be
   *  indistinguishable from an NFT with no history. */
  const byId = new Map();
  for (const id of ids) byId.set(id, emptyEvents());

  const base = {
    provider: o.provider,
    iface: o.iface,
    address: o.address,
    fromBlock: unionFrom,
    toBlock: head,
    chunkSize: o.chunkSize,
  };
  const FIELD = {
    IncreaseLiquidity: "ilEvents",
    Collect: "collectEvents",
    DecreaseLiquidity: "dlEvents",
  };
  for (const name of EVENT_NAMES) {
    const perGroup = await Promise.all(
      groups.map((g) => _scanGroup(base, name, g)),
    );
    const split = _keepAtOrAbove(perGroup.flat(), floors);
    for (const [id, logs] of split.entries()) {
      const entry = byId.get(id);
      if (entry === undefined) continue;
      entry[FIELD[name]] = o.parseLogs(o.iface, logs);
      if (name === "IncreaseLiquidity") entry.ilLogsCount = logs.length;
    }
  }
  return byId;
}

/**
 * Read one NFT's events out of a batch result.
 *
 * Throws when the id was not part of the batch. That is the point: a
 * caller reaching for an id the query was never prepared with has a
 * bug, and returning an empty result would hide it as "this NFT has no
 * history" — which downstream reads as a closed epoch with no fees.
 *
 * @param {Map<string, object>} batch
 * @param {string|number} tokenId
 * @returns {object}
 */
function eventsFor(batch, tokenId) {
  const id = String(tokenId);
  const hit = batch.get(id);
  if (hit === undefined) {
    throw new Error(
      `nft-events-batch: no events fetched for #${id} — the batch was ` +
        `prepared for ${batch.size} other id(s). Add it to tokenIds.`,
    );
  }
  return hit;
}

module.exports = {
  ID_BATCH_SIZE,
  EVENT_NAMES,
  topicForTokenId,
  tokenIdOfLog,
  scanFloors,
  emptyEvents,
  fetchChainNftEvents,
  eventsFor,
  _chunkIds,
  _keepAtOrAbove,
};
