"use strict";

/**
 * @file util/migration/from-0.9.10/drop-old-deposit-lists.js
 * @description
 * A migration step: take out each deposit list that 0.9.10 or earlier
 * built in a way this release does not, with the Total Lifetime Deposit
 * priced from it, so the first start of this release builds the list
 * again from the blockchain and prices it again.
 *
 * For each pool a position is in, LP Ranger keeps the list of every
 * deposit into it, each with its coins and the block it is priced at, in
 * `app-data/scan-cache/pnl-epochs-cache.json`: once as the Lifetime
 * figures read it (`lifetimeHodlAmounts`), and once as the next scan's
 * starting point (`freshDeposits`). Total Lifetime Deposit adds the list
 * up, priced, and the position's records keep that dollar figure
 * (`totalLifetimeDepositUsd`, `app-data/position-records.json`); the
 * Lifetime IL/G measures against the list's coins.
 *
 * 0.9.10 built such a list in two ways this release does not:
 *
 * - It summed the deposits each rebalance's mint took in into one entry
 *   at the mint's block, so Total Lifetime Deposit priced them all at the
 *   mint's day. This release enters each deposit on its own, at its own
 *   block and naming its transaction (src/lib/lifetime-hodl.js). Among
 *   those deposits 0.9.10 also counted the coins another managed pool's
 *   rebalance or compound brought the wallet, when the two pools share a
 *   coin; this release counts no transaction the wallet sent itself as a
 *   deposit (src/lib/wallet-deposits.js).
 * - It judged an addition of liquidity to a position NFT after its mint
 *   by the NFT's fees. Once the NFT's additions passed the fees it had
 *   collected, all of the addition was money put in, filed at the NFT's
 *   mint block with nothing to mark it. A compound whose swap took in the
 *   wallet's coins passed them, so its deposit counted those coins a
 *   second time. This release counts an addition as money put in only
 *   when another wallet paid for it.
 *
 * This release keeps a saved list's entries as they are, so neither would
 * change until the list was built again. Each is found from the list
 * alone. A list keeps beside it the total of the deposits rebalances took
 * in (`raw0`, `raw1`; the deposit count's entries join that total too).
 * Summed deposits leave that total larger than the entries naming their
 * transaction add up to (`sumsDepositsAtAMint`), and a filed addition
 * makes the list add up to more than its first position NFT's mint plus
 * that total (`countsCoinsTwice`). For a list holding either, this step
 * removes both of its copies, and the saved Total Lifetime Deposit of
 * each position in that pool. The saved figure has to go too: a start
 * that builds a list from nothing prices it only when no figure is saved,
 * a guard against a partial list overwriting a whole one
 * (`_resolveDiskState`, src/lib/bot-recorder-lifetime.js). The first start
 * then builds the list from the blockchain and prices it, which takes
 * minutes for a position rather than the hour Reload Current Position
 * takes. Nothing else changes: the pool's per-day P&L history stays, and
 * so does every other figure and file. A list holding only its first
 * mint stays too, since this release would build the same one.
 *
 * A pool's positions are the ones whose position NFT its saved rebalance
 * history names (the event caches, `event-cache-<chain's tag>-…json`). A
 * pool with no history saved keeps its list, since its positions' figures
 * cannot be found, and the report says to reload it. The records are
 * written before the list is removed, so a run cut off between the two
 * leaves a list priced again on the next start, and the step finds it
 * again on the next run. A list this release built holds neither kind,
 * so a second run finds nothing to remove.
 *
 * Runs on Node built-ins and the dependency-free src/lib/composite-key.js,
 * like the rest of the migration.
 */

const fs = require("fs");
const path = require("path");
const { parseCompositeKey } = require("../../../src/lib/composite-key");
const {
  isGroup,
  readJson,
  writeJson,
  keepCopy,
  migrationOptions,
} = require("../settings-copies");

/** The scan caches' folder, in an install's folder. */
const _SCAN_CACHE = path.join("app-data", "scan-cache");

/** The file holding the pools' deposit lists. */
const _EPOCH_CACHE = "pnl-epochs-cache.json";

/** The positions' records, in an install's folder. */
const _RECORDS = path.join("app-data", "position-records.json");

/** The chains file this release ships, which names each chain's tag. */
const _CHAINS = path.join(
  "app-config",
  "app-defaults-for-user-configurable",
  "chains.json",
);

/** The two copies of a pool's deposit list, in the pool's entry. */
const _LISTS = Object.freeze(["lifetimeHodlAmounts", "freshDeposits"]);

/** A saved rebalance history's key: wallet, position manager, pool. */
const _HISTORY_KEY =
  /^rebalance:(0x[0-9a-f]{40}):(0x[0-9a-f]{40}):(0x[0-9a-f]{40})-(0x[0-9a-f]{40})-(\d+)$/i;

/** An amount in a coin's smallest unit, or none when it is not one. */
function _units(raw) {
  return typeof raw === "string" && /^[0-9]+$/.test(raw) ? BigInt(raw) : 0n;
}

/**
 * Whether a deposit list adds up to more than its first position NFT's
 * mint plus the deposits rebalances took in: whether 0.9.10 filed
 * additions in it. The mint is the first entry at the earliest block,
 * since 0.9.10 filed an NFT's additions after its mint's own deposit.
 * An addition another wallet paid for is this release's own entry
 * (`kind: "external"`), outside that total, and is left out of the sum.
 *
 * @param {*} list  A pool's `lifetimeHodlAmounts` or `freshDeposits`.
 * @returns {boolean}
 */
function countsCoinsTwice(list) {
  if (!isGroup(list) || !Array.isArray(list.deposits)) return false;
  const entries = list.deposits.filter(
    (d) => isGroup(d) && d.kind !== "external",
  );
  if (entries.length === 0) return false;
  let first = entries[0];
  for (const d of entries) if (d.block < first.block) first = d;
  for (const coin of ["raw0", "raw1"]) {
    const sum = entries.reduce((s, d) => s + _units(d[coin]), 0n);
    if (sum - _units(first[coin]) - _units(list[coin]) > 0n) return true;
  }
  return false;
}

/**
 * Whether a deposit list holds deposits summed into one entry at a
 * rebalance's mint block, as 0.9.10 entered them: whether the total it
 * keeps of the deposits rebalances took in is larger than its entries
 * naming their transaction add up to. This release names the transaction
 * of each deposit it enters but the first mint, and so does the deposit
 * count, so for a list this release built the two agree. An addition
 * another wallet paid for names its transaction too, but stays out of
 * that total (`kind: "external"`), and so out of the sum.
 *
 * @param {*} list  A pool's `lifetimeHodlAmounts` or `freshDeposits`.
 * @returns {boolean}
 */
function sumsDepositsAtAMint(list) {
  if (!isGroup(list) || !Array.isArray(list.deposits)) return false;
  const named = list.deposits.filter(
    (d) =>
      isGroup(d) &&
      d.kind !== "external" &&
      typeof d.txHash === "string" &&
      d.txHash !== "",
  );
  for (const coin of ["raw0", "raw1"]) {
    const total = named.reduce((s, d) => s + _units(d[coin]), 0n);
    if (_units(list[coin]) > total) return true;
  }
  return false;
}

/** A JSON file of the install, or null when it is missing or not JSON. */
function _readQuietly(file) {
  try {
    return readJson(file);
  } catch {
    /*- Each caller can do without the file: the report then names coins
     *  by address, or the pool keeps its list. */
    return null;
  }
}

/** Each chain by its tag in the scan caches' file names. */
function _chainsByTag(root) {
  const chains = _readQuietly(path.join(root, _CHAINS));
  const out = new Map();
  for (const [chain, c] of Object.entries(isGroup(chains) ? chains : {}))
    if (isGroup(c) && typeof c.cacheTag === "string" && c.cacheTag !== "")
      out.set(c.cacheTag, chain);
  return out;
}

/** The chain a saved rebalance history's file is for, or null. */
function _chainOfHistoryFile(name, tags) {
  if (!name.endsWith(".json")) return null;
  for (const [tag, chain] of tags)
    if (name.startsWith(`event-cache-${tag}-`)) return chain;
  return null;
}

/**
 * The position NFTs a saved rebalance history names: each rebalance's old
 * and new NFT, and the chain's first.
 */
function _nftsOf(history) {
  const ids = new Set();
  if (!isGroup(history)) return ids;
  const events = Array.isArray(history.events) ? history.events : [];
  const all = events.flatMap((e) =>
    isGroup(e) ? [e.oldTokenId, e.newTokenId] : [],
  );
  all.push(history.firstMintTokenId, history.chainFirstTokenId);
  for (const id of all)
    if (id !== undefined && id !== null && id !== "") ids.add(String(id));
  return ids;
}

/**
 * Each pool's position NFTs, by the pool's key in the epoch cache
 * (`chain.positionManager.wallet.token0.token1.fee`), from the saved
 * rebalance histories.
 *
 * @param {string} root  The install's folder.
 * @returns {Map<string, Set<string>>}
 */
function _poolNfts(root) {
  const tags = _chainsByTag(root);
  const dir = path.join(root, _SCAN_CACHE);
  const out = new Map();
  /*- The folder is there: the deposit lists were read from it. */
  for (const name of fs.readdirSync(dir)) {
    const chain = _chainOfHistoryFile(name, tags);
    if (chain === null) continue;
    const file = _readQuietly(path.join(dir, name));
    for (const [k, v] of Object.entries(isGroup(file) ? file : {})) {
      const m = _HISTORY_KEY.exec(k);
      if (m === null) continue;
      const [, wallet, pm, t0, t1, fee] = m;
      const pool = [chain, pm, wallet, t0, t1, fee].join(".").toLowerCase();
      const ids = out.get(pool) ?? new Set();
      for (const id of _nftsOf(v?.value)) ids.add(id);
      out.set(pool, ids);
    }
  }
  return out;
}

/** The coins' names the token-symbol cache holds, or none. */
function _coinNames(root) {
  const names = _readQuietly(
    path.join(root, _SCAN_CACHE, "token-symbol-cache.json"),
  );
  return isGroup(names) ? names : {};
}

/**
 * A pool as the report names it, from its key in the cache: its two
 * coins, its fee and its wallet.
 *
 * @param {string} key  The pool's key.
 * @param {object} names  From `_coinNames`.
 * @returns {string}
 */
function _poolName(key, names) {
  const parts = key.split(".");
  if (parts.length !== 6) return key;
  const [chain, , wallet, t0, t1, fee] = parts;
  const coin = (a) => {
    const n = names[`${chain}-${a}`] ?? names[a];
    return typeof n === "string" && n !== "" ? n : `${a.slice(0, 8)}…`;
  };
  const w = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  return `${coin(t0)}/${coin(t1)}, fee ${Number(fee) / 10000}%, wallet ${w}`;
}

/** Whether a position's key names one of a pool's position NFTs. */
function _inPool(p, pool, nfts) {
  const [chain, pm, wallet] = pool.split(".");
  return (
    p !== null &&
    p.blockchain === chain &&
    p.wallet.toLowerCase() === wallet &&
    p.contract.toLowerCase() === pm &&
    nfts.has(String(p.tokenId))
  );
}

/**
 * Take the saved Total Lifetime Deposit out of the records of each
 * position in a pool.
 *
 * @param {object} positions  The records, by position key; changed in
 *   place.
 * @param {string} pool  The pool's key.
 * @param {Set<string>} nfts  Its position NFTs.
 * @param {Function} v  The report's verb, from `migrationOptions`.
 * @returns {string[]}  A line for each figure taken out.
 */
function _dropSavedTotals(positions, pool, nfts, v) {
  const lines = [];
  for (const [key, rec] of Object.entries(positions)) {
    const p = parseCompositeKey(key);
    if (!isGroup(rec) || !_inPool(p, pool, nfts)) continue;
    if (!Object.hasOwn(rec, "totalLifetimeDepositUsd")) continue;
    delete rec.totalLifetimeDepositUsd;
    delete rec.depositUsedFallback;
    lines.push(
      `position-records.json: ${v("removed", "would remove")} the saved Total Lifetime Deposit of NFT #${p.tokenId}, priced from that list; the first start prices it again`,
    );
  }
  return lines;
}

/**
 * What a pool's deposit list holds that this release would not build, as
 * the report says it, or "" for a list this release would build the
 * same.
 *
 * @param {*} entry  The pool's entry in the epoch cache.
 * @returns {string}
 */
function _reasonFor(entry) {
  if (!isGroup(entry)) return "";
  const reasons = [];
  if (_LISTS.some((k) => countsCoinsTwice(entry[k])))
    reasons.push(
      "counted coins the wallet paid with as money put in a second time",
    );
  if (_LISTS.some((k) => sumsDepositsAtAMint(entry[k])))
    reasons.push(
      "priced the deposits each rebalance took in at that rebalance's day",
    );
  return reasons.join(" and ");
}

/**
 * The pools whose deposit list this release would build otherwise, each
 * with what its list holds.
 *
 * @param {object} cache  The epoch cache.
 * @returns {Array<[string, string]>}  The pool's key and `_reasonFor`'s
 *   words.
 */
function _poolsToBuildAgain(cache) {
  return Object.entries(cache)
    .map(([key, entry]) => [key, _reasonFor(entry)])
    .filter(([, reason]) => reason !== "");
}

/**
 * Write a changed file of the install, keeping a copy of the old one in
 * its `tmp/` first, unless this is a dry run.
 *
 * @returns {string[]}  The line naming the copy, or none.
 */
function _save(root, file, value, o) {
  if (o.dryRun) return [];
  const line = keepCopy(root, file, o.stamp);
  writeJson(file, value);
  return [line];
}

/**
 * Take each deposit list this release would build otherwise out of the
 * scan cache, with its positions' saved Total Lifetime Deposit.
 *
 * @param {object} o
 * @param {string} o.root     The install's folder.
 * @param {boolean} o.dryRun  Report what would come out, and change nothing.
 * @returns {string[]}  A line for each list and figure taken out, or left.
 */
function dropOldDepositLists({ root, dryRun }) {
  const o = migrationOptions(dryRun);
  const cacheFile = path.join(root, _SCAN_CACHE, _EPOCH_CACHE);
  let cache;
  try {
    cache = readJson(cacheFile);
  } catch (err) {
    return [`${_EPOCH_CACHE}: not valid JSON (${err.message}); left as it was`];
  }
  if (!isGroup(cache)) return [];
  const pools = _poolsToBuildAgain(cache);
  if (pools.length === 0) return [];
  const recordsFile = path.join(root, _RECORDS);
  const records = _readQuietly(recordsFile);
  const positions = isGroup(records?.positions) ? records.positions : {};
  const poolNfts = _poolNfts(root);
  const names = _coinNames(root);
  const cacheLines = [];
  const recordLines = [];
  let cacheChanged = false;
  for (const [pool, reason] of pools) {
    const nfts = poolNfts.get(pool.toLowerCase());
    const name = _poolName(pool, names);
    if (nfts === undefined) {
      cacheLines.push(
        `${_EPOCH_CACHE}: the deposit list of ${name} ${reason}, but no saved rebalance history names its position, so it is left as it was; click Reload Current Position on that position`,
      );
      continue;
    }
    recordLines.push(..._dropSavedTotals(positions, pool, nfts, o.verb));
    for (const k of _LISTS) delete cache[pool][k];
    cacheChanged = true;
    cacheLines.push(
      `${_EPOCH_CACHE}: ${o.verb("removed", "would remove")} the deposit list of ${name}, which ${reason}; the first start builds it again from the blockchain`,
    );
  }
  const lines = [...cacheLines, ...recordLines];
  if (recordLines.length > 0)
    lines.push(..._save(root, recordsFile, records, o));
  if (cacheChanged) lines.push(..._save(root, cacheFile, cache, o));
  return lines;
}

module.exports = {
  dropOldDepositLists,
  countsCoinsTwice,
  sumsDepositsAtAMint,
};
