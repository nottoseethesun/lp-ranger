/**
 * @file src/lib/compounded-coins.js
 * @module compounded-coins
 * @description
 * What a compound counts as Fees Compounded: the fees its deposit put back
 * into the position, and none of the wallet's other coins.
 *
 * A compound collects the position's fees into the wallet, may swap them
 * to the range's ratio, and deposits them back into the same NFT. When
 * the swap runs, the deposit is offered the wallet's whole balance of the
 * pool's two coins (`_resolveDepositAmounts`, src/lib/compounder.js), so it
 * can also take in coins the wallet held before the collect: a deposit
 * the owner made, coins a rebalance left, or what the first mint left.
 * None of them is a fee. Counted as one, a coin would raise Fees
 * Compounded by its size, and read as a loss of that size in the Lifetime
 * IL/G, which takes Fees Compounded off the position's side.
 *
 * The compound reads the wallet's two coins before its collect and again
 * just before its deposit. Coin by coin, its deposit took from the
 * wallet's earlier balance what the wallet held before the collect, less
 * what it held after the deposit; the rest of the deposit is fees
 * (`compoundFeeUnits`). The compound's record keeps that rest
 * (`amount0Compounded`, `amount1Compounded`) beside the whole deposit
 * (`amount0Deposited`, `amount1Deposited`), each in the coin's smallest
 * unit.
 *
 * Coins can also reach the wallet between those two readings: a deposit
 * the owner sends while the collect or the swap is under way. The
 * readings cannot tell such coins from fees, so the fees are also capped
 * at what the compound's own transactions moved (`feeCoins`): what the
 * collect's transaction reports collecting, less what the swap's sent of
 * the token sold, plus what it received of the token bought. A deposit is
 * a transaction of its own, so it is in none of them, and counts as the
 * owner's money, never as fees.
 *
 * Every figure that counts an NFT's compounds reads them through
 * `compoundedUnits` or `compoundedCoins`: the record's fees when it has
 * them, else the whole deposit, as for a compound made before the readings
 * were kept or not by this install. The lifetime total of Fees Compounded
 * takes every fee a compound collected instead, as a rebuild of the
 * compound list counts them (src/lib/bot-cycle-compound.js). The Lifetime
 * scan counts no addition the wallet paid for as
 * money put in, and reads no receipt for the compounds `recordedCompounds`
 * names, which LP Ranger made from the wallet (src/lib/lifetime-hodl.js).
 *
 * The rest of such a deposit, the wallet's coins it took in beyond its
 * fees, went into the NFT after its mint (`walletCoinsPutIn`). The
 * Current IL/G and the Impermanent Loss Guard count those coins with the
 * coins the NFT was minted with, so the comparison stays even: the
 * position's value holds them, so the holding it is measured against
 * does too (src/lib/bot-pnl-il.js). The list holds the additions other
 * wallets paid for too, as compounds with no collect before them; all of
 * such an addition went in beyond fees, so those counts include it.
 *
 * A deposit takes only what fits the range, so some of the fees can stay
 * in the wallet. They are the fee coins the compound's own transactions
 * left it with, less what the deposit put back; its record keeps them
 * (`amount0FeesLeft`, `amount1FeesLeft`), and the Current panel counts
 * them among this NFT's fees (`feesLeftInWallet`). Only a compound that
 * read its fee coins from its own transactions names them.
 *
 * Pure: no files, no chain, no logging.
 */

"use strict";

const { isPlainObject } = require("./plain-object");
const { coinsFromUnits } = require("./coin-value");

/**
 * An amount in a coin's smallest unit, as a bigint: one given as a bigint,
 * a string of digits or a whole number, none below zero. Null otherwise.
 */
function _units(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    return BigInt(v);
  return null;
}

/**
 * The fees a compound's deposit put back, coin by coin: what it deposited,
 * less what it took from the wallet's earlier balance.
 *
 * What it took is the wallet before the collect less the wallet after the
 * deposit, which is the wallet just before the deposit less what the
 * deposit took. When the wallet ends with at least what it started with,
 * the deposit took nothing from that balance: all of it was fees, and any
 * fees it did not take stay in the wallet. A wallet that lost more than
 * the deposit took, because coins left it meanwhile, counts no fees for
 * that coin rather than a negative amount.
 *
 * @param {{raw0: bigint, raw1: bigint}} walletBefore  The wallet's two
 *   coins before the collect, in each coin's smallest unit.
 * @param {{raw0: bigint, raw1: bigint}} walletBeforeDeposit  The same,
 *   just before the deposit: after the swap when it ran, else after the
 *   collect.
 * @param {{raw0: bigint, raw1: bigint}} deposited  What the deposit took.
 * @param {{raw0: bigint, raw1: bigint}|null} [feeCoins]  The fee coins as
 *   the compound's own transactions moved them, after the swap; no fee
 *   counted exceeds them. Absent or null, the readings alone decide, as
 *   for a compound whose swap's receipt could not be read.
 * @returns {{raw0: bigint, raw1: bigint}|null}  Null when a reading is not
 *   an amount, so the caller records no fees and the whole deposit counts.
 */
function compoundFeeUnits(
  walletBefore,
  walletBeforeDeposit,
  deposited,
  feeCoins,
) {
  const out = {};
  for (const k of ["raw0", "raw1"]) {
    const before = _units(walletBefore?.[k]);
    const ready = _units(walletBeforeDeposit?.[k]);
    const dep = _units(deposited?.[k]);
    if (before === null || ready === null || dep === null) return null;
    const after = ready - dep;
    const took = before > after ? before - after : 0n;
    out[k] = took >= dep ? 0n : dep - took;
    const cap = _units(feeCoins?.[k]);
    if (cap !== null && out[k] > cap) out[k] = cap;
  }
  return out;
}

/**
 * The fees a compound's deposit could not take, coin by coin: its fee
 * coins, as its own transactions moved them, less the fees the deposit
 * put back, which never exceed them.
 *
 * @param {{raw0: bigint, raw1: bigint}|null|undefined} feeCoins  The fee
 *   coins after the swap.
 * @param {{raw0: bigint, raw1: bigint}} putBack  From `compoundFeeUnits`.
 * @returns {{amount0FeesLeft?: string, amount1FeesLeft?: string}}  None
 *   without the fee coins: the readings alone cannot tell the fees from a
 *   deposit that reached the wallet while the compound ran.
 */
function _feesLeft(feeCoins, putBack) {
  const cap0 = _units(feeCoins?.raw0);
  const cap1 = _units(feeCoins?.raw1);
  if (cap0 === null || cap1 === null) return {};
  return {
    amount0FeesLeft: String(cap0 - putBack.raw0),
    amount1FeesLeft: String(cap1 - putBack.raw1),
  };
}

/**
 * The fields a compound's result carries for the fees its deposit put
 * back, and its record keeps: in each coin's smallest unit
 * (`amount0Compounded`, `amount1Compounded`) and in whole coins
 * (`feesCompounded`); and the fees it left in the wallet
 * (`amount0FeesLeft`, `amount1FeesLeft`), when its fee coins are known.
 * None when a reading is missing, so the whole deposit counts, as it did
 * before the readings were kept.
 *
 * @param {{raw0: bigint, raw1: bigint}} walletBefore  The wallet's two
 *   coins before the collect.
 * @param {{raw0: bigint, raw1: bigint}} walletBeforeDeposit  The same,
 *   just before the deposit.
 * @param {{amount0Deposited: bigint, amount1Deposited: bigint}} deposited
 *   The deposit's result.
 * @param {number} d0  Token0's decimals.
 * @param {number} d1  Token1's decimals.
 * @param {{raw0: bigint, raw1: bigint}|null} [feeCoins]  As for
 *   `compoundFeeUnits`.
 * @returns {{amount0Compounded?: string, amount1Compounded?: string,
 *   feesCompounded?: {amount0: number, amount1: number}|null,
 *   amount0FeesLeft?: string, amount1FeesLeft?: string}}
 */
function compoundedFields(
  walletBefore,
  walletBeforeDeposit,
  deposited,
  d0,
  d1,
  feeCoins,
) {
  const fees = compoundFeeUnits(
    walletBefore,
    walletBeforeDeposit,
    {
      raw0: deposited?.amount0Deposited,
      raw1: deposited?.amount1Deposited,
    },
    feeCoins,
  );
  if (fees === null) return {};
  return {
    amount0Compounded: String(fees.raw0),
    amount1Compounded: String(fees.raw1),
    feesCompounded: coinsFromUnits(fees.raw0, fees.raw1, d0, d1),
    ..._feesLeft(feeCoins, fees),
  };
}

/**
 * The compounds this install made, by lower-cased transaction: the
 * entries of a position's compound list its bot recorded live, as an
 * automatic compound or a Compound Now. A rebuild of the list writes the
 * others with trigger `unknown` (`historical` before that).
 *
 * @param {object[]|undefined} history  The position's `compoundHistory`.
 * @returns {Map<string, object>}
 */
function recordedCompounds(history) {
  const out = new Map();
  for (const e of Array.isArray(history) ? history : []) {
    if (!isPlainObject(e) || typeof e.txHash !== "string") continue;
    if (e.trigger === "auto" || e.trigger === "manual")
      out.set(e.txHash.toLowerCase(), e);
  }
  return out;
}

/**
 * The entries of a position's compound list that name the fees their
 * deposits put back, by lower-cased transaction: those the bot recorded
 * as it made the compound, and those a rebuild of the list worked out
 * from the chain (src/lib/compound-fees-on-chain.js). What a count of
 * Fees Compounded reads each compound's fees from (`compoundedCoins`);
 * `recordedCompounds` names only the compounds this install made.
 *
 * @param {object[]|undefined} history  The position's `compoundHistory`.
 * @returns {Map<string, object>}
 */
function feeRecords(history) {
  const out = new Map();
  for (const e of Array.isArray(history) ? history : []) {
    if (!isPlainObject(e) || typeof e.txHash !== "string") continue;
    if (
      _units(e.amount0Compounded) !== null &&
      _units(e.amount1Compounded) !== null
    )
      out.set(e.txHash.toLowerCase(), e);
  }
  return out;
}

/**
 * Whether an NFT holds a compound whose entry in the position's list
 * names no fees its deposit put back (`feeRecords`), as one made before
 * 0.9.11 or outside LP Ranger does: a rebuild of the list works them out
 * from the chain (src/lib/compound-fees-on-chain.js).
 *
 * @param {object[]|undefined} history  The position's compound list.
 * @param {string|number|undefined} tokenId  The NFT.
 * @returns {boolean}
 */
function namesNoFeesOn(history, tokenId) {
  if (!Array.isArray(history) || tokenId === undefined) return false;
  const named = feeRecords(history);
  return history.some(
    (e) =>
      isPlainObject(e) &&
      typeof e.txHash === "string" &&
      String(e.tokenId) === String(tokenId) &&
      !named.has(e.txHash.toLowerCase()),
  );
}

/**
 * The coins each NFT compounded, from a position's compound list: each
 * compound counts the fees its entry names, else its whole deposit
 * (`compoundedCoins`). A rebuild of the list writes these per-NFT coins,
 * which the Current panel prices where it shows them
 * (src/lib/bot-recorder-lifetime.js, src/lib/bot-pnl-current-nft.js).
 *
 * @param {object[]} history  The compound list.
 * @param {number} d0  Token0's decimals.
 * @param {number} d1  Token1's decimals.
 * @returns {Object<string, {amount0: number, amount1: number}>}
 */
function compoundedCoinsByNft(history, d0, d1) {
  const byTokenId = {};
  for (const c of history) {
    const tid = String(c.tokenId);
    const held = byTokenId[tid] || { amount0: 0, amount1: 0 };
    const coins = compoundedCoins([c], undefined, d0, d1);
    held.amount0 += coins.amount0;
    held.amount1 += coins.amount1;
    byTokenId[tid] = held;
  }
  return byTokenId;
}

/**
 * The coins a compound counts as Fees Compounded, in each coin's smallest
 * unit: the fees its record says the deposit put back, else the whole
 * deposit.
 *
 * @param {{raw0: bigint|string, raw1: bigint|string}} deposited  What the
 *   deposit took.
 * @param {object|undefined} record  The compound's record, when it has
 *   one.
 * @returns {{raw0: bigint, raw1: bigint}}
 */
function compoundedUnits(deposited, record) {
  const fee0 = _units(record?.amount0Compounded);
  const fee1 = _units(record?.amount1Compounded);
  if (fee0 !== null && fee1 !== null) return { raw0: fee0, raw1: fee1 };
  return {
    raw0: _units(deposited?.raw0) ?? 0n,
    raw1: _units(deposited?.raw1) ?? 0n,
  };
}

/**
 * The whole coins a list of compounds counts as Fees Compounded.
 *
 * Each entry is a compound as the chain shows it or as the position's list
 * holds it (`amount0Deposited`, `amount1Deposited`, `txHash`). Its record
 * is the one `recorded` holds for its transaction, else the entry itself,
 * so a list of records needs no `recorded`.
 *
 * @param {object[]|undefined} entries  The compounds.
 * @param {Map<string, object>} [recorded]  From `recordedCompounds`.
 * @param {number} d0  Token0's decimals.
 * @param {number} d1  Token1's decimals.
 * @returns {{amount0: number, amount1: number}}
 */
function compoundedCoins(entries, recorded, d0, d1) {
  let amount0 = 0;
  let amount1 = 0;
  for (const c of Array.isArray(entries) ? entries : []) {
    if (!isPlainObject(c)) continue;
    const tx = typeof c.txHash === "string" ? c.txHash.toLowerCase() : "";
    const record = recorded?.get(tx) ?? c;
    const units = compoundedUnits(
      { raw0: c.amount0Deposited, raw1: c.amount1Deposited },
      record,
    );
    amount0 += Number(units.raw0) / 10 ** d0;
    amount1 += Number(units.raw1) / 10 ** d1;
  }
  return { amount0, amount1 };
}

/** What a deposit took beyond its fees, in a coin's smallest unit. */
function _beyondFees(deposited, fees) {
  return deposited > fees ? deposited - fees : 0n;
}

/**
 * The coins one compound's deposit took in beyond its fees, in whole
 * coins: the wallet's, such as a deposit the owner made, coins a rebalance
 * left, or fees an earlier compound left behind; or, for an addition
 * another wallet paid for, which the list holds as a compound with no
 * collect before it, all of that addition. The readers that count only
 * the wallet's coins leave such an addition out (`paidForByAnotherWallet`,
 * src/lib/counted-deposits.js). Null when its record does not tell its
 * fees apart from the rest of its deposit: such a compound counts its
 * whole deposit as Fees Compounded (`compoundedUnits`), so it took
 * nothing here.
 *
 * @param {object} compound  One entry of the position's compound list.
 * @param {number} d0  Token0's decimals.
 * @param {number} d1  Token1's decimals.
 * @returns {{amount0: number, amount1: number}|null}
 */
function walletCoinsOf(compound, d0, d1) {
  const fee0 = _units(compound.amount0Compounded);
  const fee1 = _units(compound.amount1Compounded);
  const dep0 = _units(compound.amount0Deposited);
  const dep1 = _units(compound.amount1Deposited);
  if (fee0 === null || fee1 === null || dep0 === null || dep1 === null)
    return null;
  return {
    amount0: Number(_beyondFees(dep0, fee0)) / 10 ** d0,
    amount1: Number(_beyondFees(dep1, fee1)) / 10 ** d1,
  };
}

/**
 * The coins the compounds of one NFT took in beyond their fees, in whole
 * coins (`walletCoinsOf`, summed), another wallet's additions included.
 * They went into the NFT after its mint, so the position's value holds
 * them, and the Current IL/G's holding side counts them
 * (src/lib/bot-pnl-il.js).
 *
 * @param {object[]|undefined} history  The position's compound list.
 * @param {string|number} tokenId  The NFT.
 * @param {number} d0  Token0's decimals.
 * @param {number} d1  Token1's decimals.
 * @returns {{amount0: number, amount1: number}}
 */
function walletCoinsPutIn(history, tokenId, d0, d1) {
  let amount0 = 0;
  let amount1 = 0;
  for (const c of Array.isArray(history) ? history : []) {
    if (!isPlainObject(c) || String(c.tokenId) !== String(tokenId)) continue;
    const coins = walletCoinsOf(c, d0, d1);
    if (coins === null) continue;
    amount0 += coins.amount0;
    amount1 += coins.amount1;
  }
  return { amount0, amount1 };
}

/**
 * The fees the compounds of one NFT collected and could not put back, in
 * whole coins: what waits in the wallet, earned by this NFT, until a
 * rebalance mints it into the next one. A compound whose record names no
 * fees left adds none.
 *
 * @param {object[]|undefined} history  The position's compound list.
 * @param {string|number} tokenId  The NFT.
 * @param {number} d0  Token0's decimals.
 * @param {number} d1  Token1's decimals.
 * @returns {{amount0: number, amount1: number}}
 */
function feesLeftInWallet(history, tokenId, d0, d1) {
  let amount0 = 0;
  let amount1 = 0;
  for (const c of Array.isArray(history) ? history : []) {
    if (!isPlainObject(c) || String(c.tokenId) !== String(tokenId)) continue;
    const left0 = _units(c.amount0FeesLeft);
    const left1 = _units(c.amount1FeesLeft);
    if (left0 === null || left1 === null) continue;
    amount0 += Number(left0) / 10 ** d0;
    amount1 += Number(left1) / 10 ** d1;
  }
  return { amount0, amount1 };
}

module.exports = {
  compoundFeeUnits,
  compoundedFields,
  recordedCompounds,
  feeRecords,
  namesNoFeesOn,
  compoundedCoinsByNft,
  compoundedUnits,
  compoundedCoins,
  walletCoinsOf,
  walletCoinsPutIn,
  feesLeftInWallet,
};
