/**
 * @file src/bot-recorder-decimals-heal.js
 * @module bot-recorder-decimals-heal
 * @description
 * The lifetime scan's token-decimals heal: make sure a position carries
 * valid on-chain token decimals before the scan values anything, honour the
 * operator's manual override, and decide what an unreadable value means —
 * retire the position, or skip this run and retry.
 *
 * Extracted from `bot-recorder-lifetime.js`, which runs the heal at the
 * start of every lifetime scan, to keep that file under the 500-line cap.
 * Everything here writes under the `[token-decimals]` log tag, and its
 * error.log entries carry their own per-pool scope so a later successful
 * heal can clear them.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const ethers = require("ethers");
const { getPoolState } = require("./rebalancer-pools");
const {
  PoolStateInvalidError,
  isIntegerInRange,
} = require("./pool-state-validate");
const {
  writeErrorLog,
  clearErrorLog,
  getErrorLogPath,
} = require("./error-log");

/*- ERC-20 decimals validity uses the SAME predicate + range that getPoolState
 *  validates against, so the heal's "already good?" check and getPoolState's
 *  authoritative validation never disagree. */
function _validDecimals(d) {
  return isIntegerInRange(d, 0, 77);
}

/*- A force-override value for one token: the operator's manual entry that
 *  must win over any on-chain read. Returns the value when its force flag is
 *  set AND the value is a plausible decimals number, else null. */
function _forcedDecimals(override, valueKey, forceKey) {
  return override[forceKey] === true && _validDecimals(override[valueKey])
    ? override[valueKey]
    : null;
}

/*- True when no heal work is needed: nothing is force-overridden and the
 *  position already carries valid decimals. */
function _decimalsSettled(position, forced0, forced1) {
  return (
    forced0 === null &&
    forced1 === null &&
    _validDecimals(position.decimals0) &&
    _validDecimals(position.decimals1)
  );
}

/*- getPoolState opts for a position. */
function _poolStateOpts(position) {
  return {
    factoryAddress: config.FACTORY,
    token0: position.token0,
    token1: position.token1,
    fee: position.fee,
  };
}

/*- User-facing auto-stop explanation for an unhealable decimals defect —
 *  carried verbatim into the `positionDataInvalid` Telegram notification. */
function _retireMessage(err) {
  return (
    "Token decimals are unreadable/invalid on-chain (" +
    err.field +
    " = " +
    String(err.value) +
    ") and no valid manual decimals override is set, so this position cannot" +
    " be valued and was automatically removed from management. The NFT is not" +
    " burned and your funds are untouched — enter the decimals manually in" +
    " Pool Details, then re-manage the position."
  );
}

/*- Classify a getPoolState failure during the heal. A decimals-field
 *  validation failure falls back to a COMPLETE manual override (getPoolState
 *  returns neither value when it throws, so both decimals must be overridden)
 *  or else retires. Every other failure (RPC exhaustion, or a non-decimals
 *  field like price/sqrtPrice/tickSpacing) is transient — pollCycle tolerates
 *  the same getPoolState failures as pollErrors, so we never retire a live
 *  position for a pool-state hiccup, only for a definitive decimals defect. */
function _classifyHealError(err, position, override) {
  const isDecimalsDefect =
    err instanceof PoolStateInvalidError &&
    (err.field === "decimals0" || err.field === "decimals1");
  if (isDecimalsDefect) {
    if (_validDecimals(override.d0) && _validDecimals(override.d1)) {
      position.decimals0 = override.d0;
      position.decimals1 = override.d1;
      return { ok: true, resolved: true, source: "override" };
    }
    return { retire: true, reason: _retireMessage(err), err };
  }
  return {
    transient: true,
    reason:
      err !== null && err !== undefined && typeof err.message === "string"
        ? err.message
        : String(err),
  };
}

/**
 * Ensure the position carries valid on-chain token decimals before the scan
 * values it.  Resolves them through `getPoolState` — the single entry point
 * for on-chain pool/token state (it validates decimals + retries across
 * RPCs) — decoupled from the price-gated init in `bot-loop-detect.js`,
 * which skips caching decimals for a token that has no price at startup.
 * Undefined decimals make `10 ** d` NaN and poison every amount derived
 * from them, leaving the deposit total at `$0` and the badge on
 * "Syncing…".  See the "getPoolState Validation" section in
 * docs/engineering.md.
 *
 * Honors the operator's manual override (`{ d0, force0, d1, force1 }`):
 *   - a **force**d token's manual value always wins, even over a good chain read;
 *   - a non-force value is a **fallback** used only when getPoolState fails.
 *
 * Runs unconditionally on a full rescan ("Reload Current Position", which
 * sets `_needsFullRescan`), so Reload re-reads decimals through this same
 * path with zero duplication; on incremental scans, only when a heal is
 * actually needed.
 *
 * @param {object} position     Live position (mutated in place on success).
 * @param {boolean} fullRescan  True to re-resolve even when decimals look valid.
 * @param {object} override     Manual override { d0, force0, d1, force1 }.
 * @param {Function} [getState]  Injected `getPoolState` (for tests).
 * @returns {Promise<
 *   {ok: true, resolved?: boolean, source?: string} |
 *   {retire: true, reason: string, err: Error} |
 *   {transient: true, reason: string}
 * >}  `resolved` marks a run that actually set decimals (vs a no-op
 *   short-circuit). `retire` = unhealable decimals defect; `transient` = RPC
 *   exhaustion or a non-decimals pool-state issue (retry next rescan).
 */
async function _ensureTokenDecimals(
  position,
  fullRescan,
  override,
  getState = getPoolState,
) {
  const ov = override || {};
  const forced0 = _forcedDecimals(ov, "d0", "force0");
  const forced1 = _forcedDecimals(ov, "d1", "force1");
  if (!fullRescan && _decimalsSettled(position, forced0, forced1))
    return { ok: true };
  if (forced0 !== null && forced1 !== null) {
    position.decimals0 = forced0;
    position.decimals1 = forced1;
    return { ok: true, resolved: true, source: "force" };
  }
  try {
    /*- getPoolState ignores its provider arg (builds its own per-RPC
     *  providers for the retry chain); pass null explicitly. */
    const ps = await getState(null, ethers, _poolStateOpts(position));
    position.decimals0 = forced0 !== null ? forced0 : ps.decimals0;
    position.decimals1 = forced1 !== null ? forced1 : ps.decimals1;
    return { ok: true, resolved: true, source: "chain" };
  } catch (err) {
    return _classifyHealError(err, position, ov);
  }
}

/**
 * Read the operator's manual decimals override for this position from
 * config: { d0, force0, d1, force1 }. Non-number values stay undefined so
 * `_validDecimals` rejects them.
 *
 * @param {object} [botState]  Bot state carrying `_getConfig`.
 * @returns {{d0?: number, force0?: boolean, d1?: number, force1?: boolean}}
 */
function _readDecimalsOverride(botState) {
  const get = botState && botState._getConfig;
  if (typeof get !== "function") return {};
  const num = (v) => (typeof v === "number" ? v : undefined);
  return {
    d0: num(get("decimalsOverride0")),
    force0: get("decimalsOverrideForce0") === true,
    d1: num(get("decimalsOverride1")),
    force1: get("decimalsOverrideForce1") === true,
  };
}

/*- Stable per-pool tag for token-decimals error.log entries. token0_token1_fee
 *  survives rebalances (unlike tokenId), so the write and the self-clear match
 *  the same pool. */
function _decimalsScopeTag(position) {
  return (
    "[token-decimals] scope=" +
    String(position.token0).toLowerCase() +
    "_" +
    String(position.token1).toLowerCase() +
    "_" +
    (position.fee === undefined || position.fee === null ? 0 : position.fee)
  );
}

/*- Full-context error.log line for an unhealable token-decimals problem:
 *  scope tag + symbols + NFT id + emoji + factory. */
function _decimalsErrContext(ctx, position) {
  return (
    _decimalsScopeTag(position) +
    " " +
    ctx.t0Sym +
    "/" +
    ctx.t1Sym +
    " NFT #" +
    ctx.tokenIdStr +
    " " +
    ctx.tokenEmoji +
    " factory=" +
    config.POSITION_MANAGER
  );
}

/**
 * Act on the heal result inside the scan. Retire: stamp `_retireReason`
 * (next poll auto-stops via checkRetireRequest -> onRetire) + write a
 * durable error.log entry. Transient: log + skip this run. Resolved:
 * self-clear any stale error.log entry for this pool + log the
 * source/values.
 *
 * @param {object} heal  Result of `_ensureTokenDecimals`.
 * @param {object} botState  Live per-position bot state.
 * @param {object} position  Live position.
 * @param {{t0Sym: string, t1Sym: string, tokenIdStr: string,
 *   tokenEmoji: string}} ctx  Log context.
 * @returns {boolean}  True when the scan must abort (retire or transient),
 *   false to proceed.
 */
function _handleHealResult(heal, botState, position, ctx) {
  if (heal.retire) {
    botState._retireReason = heal.reason;
    writeErrorLog(heal.err, _decimalsErrContext(ctx, position));
    log.warn(
      "[token-decimals] %s/%s NFT #%s %s: unhealable — auto-stopping + logged to %s: %s",
      ctx.t0Sym,
      ctx.t1Sym,
      ctx.tokenIdStr,
      ctx.tokenEmoji,
      getErrorLogPath(),
      heal.reason,
    );
    return true;
  }
  if (heal.transient) {
    log.warn(
      "[token-decimals] %s/%s NFT #%s %s: transient decimals-read error (%s)" +
        " — will retry next rescan",
      ctx.t0Sym,
      ctx.t1Sym,
      ctx.tokenIdStr,
      ctx.tokenEmoji,
      heal.reason,
    );
    return true;
  }
  if (heal.resolved) {
    clearErrorLog(_decimalsScopeTag(position));
    log.info(
      "[token-decimals] %s/%s NFT #%s %s: decimals OK via %s (d0=%s d1=%s)",
      ctx.t0Sym,
      ctx.t1Sym,
      ctx.tokenIdStr,
      ctx.tokenEmoji,
      heal.source,
      position.decimals0,
      position.decimals1,
    );
  }
  return false;
}

module.exports = {
  _ensureTokenDecimals,
  _handleHealResult,
  _readDecimalsOverride,
};
