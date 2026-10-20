"use strict";

/**
 * @file util/bookkeeping/coins-in-transactions-on-wallet/moves.js
 * @description
 * The rebalances and compounds LP Ranger has recorded for one wallet, read
 * from `app-data/` with no chain call, as the guide's section on what
 * `app-data/` records describes:
 *
 * - every rebalance from the event caches in `scan-cache/`, each of which
 *   holds every mint in one pool's chain of NFTs with the NFT it
 *   replaced, and from `rebalance_log.json`, which adds the transactions
 *   and the coins' decimals for the rebalances this install made;
 * - every compound from each position's `compoundHistory` in
 *   `position-records.json`, one entry per deposit into an NFT after its
 *   mint;
 * - each NFT's two coins, and their symbols, from the LP position cache.
 *
 * A move here is a rebalance or a compound: the NFTs it involves, the
 * hash of its last transaction (the mint or the deposit), and when the
 * files say it ended. The report reads the chain for the rest.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { parseCompositeKey } = require("../../../src/composite-key");
const { sameAddress } = require("../coins-in-transaction");

/**
 * How far a recorded time may sit from the block time of the move's last
 * transaction. The rebalance log and a compound's history entry are
 * written once that transaction has been mined, seconds later; an hour
 * leaves room for a slow write, and the report then decides by the block
 * time itself.
 */
const RECORD_MARGIN_MS = 60 * 60 * 1000;

/**
 * Read a json file, or null when there is none.
 * @param {string} file  Its path.
 * @returns {*}  The parsed json, or null.
 * @throws {Error} When the file exists but cannot be read or parsed.
 */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(text);
}

/**
 * The first six hex digits of an address, lower-cased, as LP Ranger's
 * cache file names carry it.
 * @param {string} address
 * @returns {string}
 */
function short(address) {
  return address.slice(2, 8).toLowerCase();
}

/**
 * Read an event-cache key, `rebalance:<wallet>:<position manager>:
 * <token0>-<token1>-<fee>`.
 * @param {string} key  A key of an event-cache file.
 * @returns {{wallet: string, positionManager: string, token0: string,
 *   token1: string}|null}  Null for any other key.
 */
function rebalanceKey(key) {
  const parts = key.split(":");
  if (parts.length !== 4 || parts[0] !== "rebalance") return null;
  const [token0, token1] = parts[3].split("-");
  if (!ethers.isAddress(token0) || !ethers.isAddress(token1)) return null;
  return {
    wallet: parts[1],
    positionManager: parts[2],
    token0: ethers.getAddress(token0),
    token1: ethers.getAddress(token1),
  };
}

/**
 * Every rebalance the event caches hold for the wallet at the position
 * manager: each mint after a chain's first, with the NFT it replaced.
 * Each also carries the block the replaced NFT was minted in, where the
 * cache knows it, below which its drain cannot be.
 *
 * @param {string} appDataDir  The `app-data/` folder.
 * @param {{cacheTag: string, wallet: string, positionManager: string}} who
 * @returns {object[]}  Rebalance moves.
 */
function cachedRebalances(appDataDir, { cacheTag, wallet, positionManager }) {
  const dir = path.join(appDataDir, "scan-cache");
  if (!fs.existsSync(dir)) return [];
  const prefix = `event-cache-${cacheTag}-${short(positionManager)}-${short(wallet)}-`;
  const moves = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const cache = readJson(path.join(dir, name));
    for (const [key, entry] of Object.entries(cache)) {
      const pool = rebalanceKey(key);
      if (pool === null) continue;
      if (!sameAddress(pool.wallet, wallet)) continue;
      if (!sameAddress(pool.positionManager, positionManager)) continue;
      moves.push(...poolRebalances(entry.value, pool));
    }
  }
  return moves;
}

/**
 * The rebalances of one pool's chain, from its event-cache entry.
 * @param {{events: object[], chainFirstTokenId?: string,
 *   chainFirstMintBlock?: number}} value  The cache entry's value.
 * @param {{token0: string, token1: string}} pool  The pool's coins.
 * @returns {object[]}  Rebalance moves.
 */
function poolRebalances(value, pool) {
  const events = value?.events ?? [];
  const mintBlocks = new Map();
  if (value?.chainFirstTokenId !== undefined)
    mintBlocks.set(String(value.chainFirstTokenId), value.chainFirstMintBlock);
  for (const e of events) mintBlocks.set(String(e.newTokenId), e.blockNumber);
  return events.map((e) => ({
    type: "rebalance",
    nfts: [String(e.oldTokenId), String(e.newTokenId)],
    lastHash: e.txHash,
    listed: [],
    endMs: e.timestamp * 1000,
    floorBlock: mintBlocks.get(String(e.oldTokenId)) ?? null,
    coins: { token0: pool.token0, token1: pool.token1 },
  }));
}

/**
 * The rebalances `rebalance_log.json` holds for the wallet at the
 * position manager. An entry the test suite wrote names no real wallet,
 * so it never matches.
 *
 * @param {string} appDataDir  The `app-data/` folder.
 * @param {{wallet: string, positionManager: string}} who
 * @returns {object[]}  Log entries.
 */
function loggedRebalances(appDataDir, { wallet, positionManager }) {
  const log = readJson(path.join(appDataDir, "rebalance_log.json")) ?? [];
  return log.filter(
    (e) =>
      typeof e.wallet === "string" &&
      typeof e.contract === "string" &&
      sameAddress(e.wallet, wallet) &&
      sameAddress(e.contract, positionManager),
  );
}

/**
 * Join the two sources of rebalances, one move per new NFT. The event
 * cache gives the mint's own time and the replaced NFT's mint block; the
 * log adds the transactions it lists.
 *
 * @param {object[]} cached  From `cachedRebalances`.
 * @param {object[]} logged  From `loggedRebalances`.
 * @returns {object[]}  Rebalance moves.
 */
function joinRebalances(cached, logged) {
  const byNewNft = new Map(cached.map((m) => [m.nfts[1], m]));
  for (const e of logged) {
    const newNft = String(e.newTokenId);
    const known = byNewNft.get(newNft);
    if (known !== undefined) {
      known.listed = e.txHashes;
      continue;
    }
    byNewNft.set(newNft, {
      type: "rebalance",
      nfts: [String(e.oldTokenId), newNft],
      lastHash: e.txHashes.at(-1),
      listed: e.txHashes,
      endMs: Date.parse(e.loggedAt),
      floorBlock: null,
      coins: {
        token0: ethers.getAddress(e.token0),
        token1: ethers.getAddress(e.token1),
      },
    });
  }
  return [...byNewNft.values()];
}

/**
 * The compounds each of the wallet's positions holds in its
 * `compoundHistory`, one move per deposit. An entry with no time is kept,
 * and placed later by its block's time.
 *
 * @param {string} appDataDir  The `app-data/` folder.
 * @param {{chain: string, wallet: string, positionManager: string}} who
 * @returns {object[]}  Compound moves.
 */
function recordedCompounds(appDataDir, { chain, wallet, positionManager }) {
  const file = path.join(appDataDir, "position-records.json");
  const positions = readJson(file)?.positions ?? {};
  const byHash = new Map();
  for (const [key, slot] of Object.entries(positions)) {
    const owner = parseCompositeKey(key);
    if (owner === null || owner.blockchain !== chain) continue;
    if (!sameAddress(owner.wallet, wallet)) continue;
    if (!sameAddress(owner.contract, positionManager)) continue;
    for (const c of slot.compoundHistory ?? []) {
      if (typeof c.txHash !== "string") continue;
      const endMs = Date.parse(c.timestamp);
      byHash.set(c.txHash, {
        type: "compound",
        nfts: [String(c.tokenId)],
        lastHash: c.txHash,
        listed: [],
        endMs: Number.isNaN(endMs) ? null : endMs,
        floorBlock: null,
        coins: null,
      });
    }
  }
  return [...byHash.values()];
}

/**
 * What the LP position cache says about the wallet's NFTs and coins:
 * each NFT's two coins, and each coin's symbol.
 *
 * @param {string} appDataDir  The `app-data/` folder.
 * @param {{cacheTag: string, wallet: string, positionManager: string}} who
 * @returns {{coinsOf: Map<string, {token0: string, token1: string}>,
 *   symbols: Map<string, string>}}  `symbols` is keyed by the coin's
 *   lower-cased address.
 */
function positionCoins(appDataDir, { cacheTag, wallet, positionManager }) {
  const name = `lp-position-cache-${cacheTag}-${short(positionManager)}-${short(wallet)}.json`;
  const cache = readJson(path.join(appDataDir, "scan-cache", name));
  const coinsOf = new Map();
  const symbols = new Map();
  for (const p of cache?.positions ?? []) {
    const token0 = ethers.getAddress(p.token0);
    const token1 = ethers.getAddress(p.token1);
    coinsOf.set(String(p.tokenId), { token0, token1 });
    if (typeof p.token0Symbol === "string")
      symbols.set(token0.toLowerCase(), p.token0Symbol);
    if (typeof p.token1Symbol === "string")
      symbols.set(token1.toLowerCase(), p.token1Symbol);
  }
  return { coinsOf, symbols };
}

/**
 * Each coin's decimals, as the rebalance log records them.
 * @param {object[]} logged  From `loggedRebalances`.
 * @returns {Map<string, number>}  Keyed by the coin's lower-cased address.
 */
function loggedDecimals(logged) {
  const decimals = new Map();
  for (const e of logged) {
    decimals.set(e.token0.toLowerCase(), e.decimals0);
    decimals.set(e.token1.toLowerCase(), e.decimals1);
  }
  return decimals;
}

/**
 * Everything `app-data/` records that a report on a range may need: the
 * moves the files place near the range, oldest first, and what they say
 * about the coins.
 *
 * @param {string} appDataDir  The `app-data/` folder.
 * @param {{chain: string, cacheTag: string, wallet: string,
 *   positionManager: string}} who
 * @param {{startMs: number, endMs: number}} range  The report's span.
 * @returns {{moves: object[], coinsOf: Map, symbols: Map,
 *   decimals: Map}}
 */
function recordsNear(appDataDir, who, range) {
  const logged = loggedRebalances(appDataDir, who);
  const all = [
    ...joinRebalances(cachedRebalances(appDataDir, who), logged),
    ...recordedCompounds(appDataDir, who),
  ];
  const lo = range.startMs - RECORD_MARGIN_MS;
  const hi = range.endMs + RECORD_MARGIN_MS;
  const moves = all
    .filter((m) => m.endMs === null || (m.endMs >= lo && m.endMs < hi))
    .sort((a, b) => (a.endMs ?? 0) - (b.endMs ?? 0));
  const { coinsOf, symbols } = positionCoins(appDataDir, who);
  return { moves, coinsOf, symbols, decimals: loggedDecimals(logged) };
}

module.exports = {
  RECORD_MARGIN_MS,
  readJson,
  rebalanceKey,
  cachedRebalances,
  loggedRebalances,
  joinRebalances,
  recordedCompounds,
  positionCoins,
  loggedDecimals,
  recordsNear,
};
