"use strict";

/**
 * @file src/lib/config-record-checks.js
 * @module config-record-checks
 * @description
 * What makes a value acceptable for each record the bot keeps per
 * position in app-data/position-records.json (src/lib/position-records.js).
 *
 * The bot writes these records itself: the HODL baseline, the coins
 * rebalances left in the wallet, the compound history and its coin
 * totals, each NFT's gas and compounded coins, and the lifetime deposit.
 * No dashboard control sets them, and `POST /api/config` takes none of
 * them. Each is held here to the shape the bot writes, field by field,
 * using the kinds of value the tests hold the shipped files to
 * (`src/lib/value-kinds.js`); the startup check holds the records file to
 * these rules (src/lib/bot-config-checks.js), so a record the next start
 * cannot read stops startup rather than the bot, and a value the bot
 * would have written passes.
 *
 * A record's fields are checked where present, and the ones its readers
 * cannot do without are required. A field no reader knows is left alone,
 * since an older release may have written it. A refusal names the field
 * and says what it must be, in the words the tests fail with.
 */

const { KINDS } = require("./value-kinds");
const { isPlainObject: _isObject } = require("./plain-object");

/** What is wrong with `v` at `where`. */
function _wrong(where, v, what) {
  return `${where} must be ${what}; it is ${JSON.stringify(v)}.`;
}

/** A check from a kind of value: null when `v` is of that kind. */
const _of = (k) => (v, where) => (k.ok(v) ? null : _wrong(where, v, k.what));

/** A check that also accepts null, which some writers leave unknown. */
const _orNull = (check) => (v, where) => (v === null ? null : check(v, where));

/**
 * An object whose fields named in `spec` pass their checks: each one in
 * `required` must be present, and the rest are checked when present.
 * @param {Record<string, Function>} spec
 * @param {string[]} [required]
 * @returns {Function} `(v, where) => string|null`
 */
function _record(spec, required = []) {
  return (v, where) => {
    if (!_isObject(v)) return _wrong(where, v, "an object");
    for (const key of required)
      if (v[key] === undefined) return `${where}.${key} is missing.`;
    for (const [key, check] of Object.entries(spec)) {
      if (v[key] === undefined) continue;
      const problem = check(v[key], `${where}.${key}`);
      if (problem) return problem;
    }
    return null;
  };
}

/**
 * An object keyed by token id or pool whose every value passes `check`.
 * @param {Function} check
 * @returns {Function}
 */
function _mapOf(check) {
  return (v, where) => {
    if (!_isObject(v)) return _wrong(where, v, "an object");
    for (const [key, each] of Object.entries(v)) {
      const problem = check(each, `${where}.${key}`);
      if (problem) return problem;
    }
    return null;
  };
}

/**
 * A list whose every entry passes `check`.
 * @param {Function} check
 * @returns {Function}
 */
function _listOf(check) {
  return (v, where) => {
    if (!Array.isArray(v)) return _wrong(where, v, "a list");
    for (const [i, each] of v.entries()) {
      const problem = check(each, `${where}[${i}]`);
      if (problem) return problem;
    }
    return null;
  };
}

/** Passes when either check does; the words are both kinds'. */
function _either(a, b, what) {
  return (v, where) =>
    a(v, where) === null || b(v, where) === null
      ? null
      : _wrong(where, v, what);
}

const _usd = _of(KINDS.usd);
const _coins = _of(KINDS.coins);
const _percent = _of(KINDS.percent);
const _digits = _of(KINDS.digits);
const _text = _of(KINDS.text);
const _isoTime = _of(KINDS.isoTime);
// A token id as written: its digits, or the number itself.
const _tokenId = _either(_digits, _of(KINDS.count), "a token id");

/*-
 *  Each record, keyed as the route receives it, with where the bot
 *  writes it.
 */
const RECORD_CHECKS = Object.freeze({
  /*-
   *  The coins the held NFT was minted with, and their worth at its mint
   *  (src/lib/hodl-baseline.js, src/lib/bot-recorder-baseline.js). The mint time
   *  is Unix seconds, or an ISO date an older release wrote.
   */
  hodlBaseline: _record(
    {
      entryValue: _usd,
      hodlAmount0: _coins,
      hodlAmount1: _coins,
      token0UsdPrice: _orNull(_usd),
      token1UsdPrice: _orNull(_usd),
      mintDate: _text,
      mintTimestamp: _either(
        _of(KINDS.count),
        _isoTime,
        "Unix seconds, or an ISO 8601 date",
      ),
      mintGasWei: _digits,
    },
    ["entryValue", "hodlAmount0", "hodlAmount1"],
  ),
  /*-
   *  Coins rebalances left in the wallet, per pool, in each token's
   *  smallest unit (src/lib/residual-tracker.js).
   */
  residuals: _mapOf(
    _record({ token0: _digits, token1: _digits }, ["token0", "token1"]),
  ),
  /*-
   *  One entry for each compound, live or found on the chain
   *  (src/lib/bot-cycle-compound.js, src/lib/bot-recorder-lifetime.js). An entry
   *  written since the Activity Log's figures began also holds the fee
   *  coins the compound collected and their share of the position at the
   *  time (src/lib/compound-activity-figures.js); either is null when it
   *  could not be worked out, and an older entry has neither.
   */
  compoundHistory: _listOf(
    _record(
      {
        timestamp: _orNull(_isoTime),
        txHash: _orNull(_text),
        tokenId: _tokenId,
        amount0Deposited: _digits,
        amount1Deposited: _digits,
        /*-
         *  The fees among the deposited coins, where the compound could
         *  tell them apart (src/lib/compounded-coins.js).
         */
        amount0Compounded: _digits,
        amount1Compounded: _digits,
        /*- The fees the deposit could not take, left in the wallet. */
        amount0FeesLeft: _digits,
        amount1FeesLeft: _digits,
        /*-
         *  The deposit's block, and the wallet's two coins before the
         *  collect, for the deposits to the wallet the compound took
         *  (src/lib/deposit-attribution.js).
         */
        blockNumber: _of(KINDS.count),
        amount0WalletBefore: _digits,
        amount1WalletBefore: _digits,
        usdValue: _usd,
        price0: _orNull(_usd),
        price1: _orNull(_usd),
        gasCostUsd: _usd,
        trigger: _text,
        feesCollected: _orNull(
          _record({ amount0: _coins, amount1: _coins }, ["amount0", "amount1"]),
        ),
        historical: _orNull(
          _record({ percentGainForPosition: _orNull(_percent) }, [
            "percentGainForPosition",
          ]),
        ),
      },
      ["amount0Deposited", "amount1Deposited"],
    ),
  ),
  compoundedAmount0: _coins,
  compoundedAmount1: _coins,
  nftGasWeiByTokenId: _mapOf(_digits),
  nftCompoundedAmountsByTokenId: _mapOf(
    _record({ amount0: _coins, amount1: _coins }, ["amount0", "amount1"]),
  ),
  lastCompoundAt: _isoTime,
  totalLifetimeDepositUsd: _usd,
  depositUsedFallback: _of(KINDS.bool),
  /*-
   *  One entry for each failed rebalance or compound that paid gas: when,
   *  the wei, and its dollars on that day (src/lib/spent-gas.js).
   */
  failedMoveGas: _listOf(
    _record({ at: _isoTime, wei: _digits, usd: _usd }, ["at", "wei", "usd"]),
  ),
});

module.exports = { RECORD_CHECKS };
