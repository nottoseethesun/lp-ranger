/**
 * @file src/gas-monitor.js
 * @module gasMonitor
 * @description
 * Monitors the wallet's native token balance and exposes a two-tier gas
 * status for both Telegram alerts and the Mission Control badge.
 *
 * Threshold formula (chain-agnostic — gas opcodes are the same on all
 * EVMs, so scaling from a 21k send is portable):
 *
 *   floor       = SEND_GAS × WORST_CASE_GAS_FACTOR            (one worst-case rebalance)
 *   recommended = SEND_GAS × WORST_CASE_GAS_FACTOR × SAFETY × positionCount
 *
 * All three numeric inputs — `worstCaseGasFactor`, `safetyMultiplier`,
 * `standardSendGas` — are loaded at module init from
 * `app-config/static-tunables/low-gas-thresholds.json` so operators can
 * retune without editing code.  The defaults match the shipped JSON and
 * are also used as a fallback when the file is missing/malformed, so
 * the guard never silently disables itself.
 *
 * The shipped default `worstCaseGasFactor = 91` was derived from
 * observed PulseChain logs for a rebalance that fired all three
 * corrective-swap iterations:
 *   remove(~209k) + primary approve(~46k) + primary swap(~243k)
 *   + 3 × corrective(approve+swap ~290k) + mint approves(~76k) + mint(~464k)
 *   ≈ 1,911,000 gas / 21,000 send ≈ 91.
 *
 * Tiers:
 *   'ok'        balance ≥ recommended
 *   'low'       floor ≤ balance < recommended   (amber, static)
 *   'critical'  balance < floor                 (blinking, one rebalance would fail)
 *
 * The Telegram alert fires once per low-balance episode at the 'low' or
 * 'critical' tier and resets when balance recovers.
 *
 * The module also keeps a singleton of the latest observation so the
 * /api/status handler can surface gas status to the UI without making
 * its own RPC call on every 3s poll.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { notify } = require("./telegram");

/** Defaults applied when the tunables JSON is missing or malformed.
 *  These are also the values shipped in the JSON so the guard stays
 *  active with reasonable thresholds even if the file is deleted. */
const _DEFAULTS = Object.freeze({
  worstCaseGasFactor: 91,
  safetyMultiplier: 3,
  standardSendGas: 21000,
});

/** On-disk source of truth for low-gas tunables. */
const _TUNABLES_PATH = path.join(
  __dirname,
  "..",
  "app-config",
  "static-tunables",
  "low-gas-thresholds.json",
);

/*- Load worstCaseGasFactor / safetyMultiplier / standardSendGas from the
 *  tunables JSON at module init. Any missing or malformed field falls
 *  back to the matching entry in _DEFAULTS — partial customisation is
 *  allowed. */
function _loadTunables() {
  const out = { ..._DEFAULTS };
  try {
    const raw = fs.readFileSync(_TUNABLES_PATH, "utf8");
    const json = JSON.parse(raw);
    for (const k of Object.keys(_DEFAULTS)) {
      const v = Number(json?.[k]);
      if (Number.isFinite(v) && v > 0) out[k] = v;
      else if (json?.[k] !== undefined)
        console.warn(
          "[gas-monitor] %s: invalid %s=%s — using default %s",
          _TUNABLES_PATH,
          k,
          json[k],
          _DEFAULTS[k],
        );
    }
    console.log(
      "[gas-monitor] Tunables loaded: worstCaseGasFactor=%d safetyMultiplier=%d standardSendGas=%d",
      out.worstCaseGasFactor,
      out.safetyMultiplier,
      out.standardSendGas,
    );
  } catch (err) {
    console.warn(
      "[gas-monitor] Could not load %s: %s — using defaults",
      _TUNABLES_PATH,
      err.message ?? err,
    );
  }
  return out;
}

const _TUNABLES = _loadTunables();

/** Worst-case rebalance gas / standard send gas. See tunables JSON. */
const WORST_CASE_GAS_FACTOR = _TUNABLES.worstCaseGasFactor;

/** Safety multiplier applied to the recommended top-up. See tunables JSON. */
const SAFETY_MULTIPLIER = _TUNABLES.safetyMultiplier;

/** Standard EVM send gas (default 21,000). See tunables JSON. */
const SEND_GAS = BigInt(_TUNABLES.standardSendGas);

/** Singleton of the latest raw observation — updated by checkGasBalance,
 *  consumed by the /api/status handler. */
let _latestObservation = null;

/**
 * Compute gas status tier from raw balance + gasPrice + position count.
 * Pure function — no I/O — so the server can recompute tier cheaply
 * whenever positionCount changes.
 *
 * @param {object} opts
 * @param {bigint} opts.balanceWei
 * @param {bigint} opts.gasPriceWei
 * @param {number} opts.positionCount   Managed-position count (≥1).
 * @returns {{
 *   level: 'ok'|'low'|'critical',
 *   balanceWei: bigint,
 *   gasPriceWei: bigint,
 *   recommendedWei: bigint,
 *   floorWei: bigint,
 *   positionCount: number,
 * }}
 */
function computeGasStatus({ balanceWei, gasPriceWei, positionCount }) {
  const n = Math.max(1, Number(positionCount) || 1);
  const perRebalance = SEND_GAS * BigInt(WORST_CASE_GAS_FACTOR);
  const floorWei = gasPriceWei * perRebalance;
  const recommendedWei =
    gasPriceWei * perRebalance * BigInt(SAFETY_MULTIPLIER) * BigInt(n);
  let level = "ok";
  if (balanceWei < floorWei) level = "critical";
  else if (balanceWei < recommendedWei) level = "low";
  return {
    level,
    balanceWei,
    gasPriceWei,
    recommendedWei,
    floorWei,
    positionCount: n,
  };
}

/**
 * Fetch balance + fee data once, return full tier info.
 * @param {object} opts
 * @param {object} opts.provider
 * @param {string} opts.address
 * @param {number} opts.positionCount
 * @returns {Promise<ReturnType<typeof computeGasStatus>|null>}
 */
async function getGasStatus({ provider, address, positionCount }) {
  if (!provider || !address) return null;
  try {
    const [balance, feeData] = await Promise.all([
      provider.getBalance(address),
      provider.getFeeData(),
    ]);
    const gasPrice = feeData?.gasPrice ?? 0n;
    if (gasPrice <= 0n) return null;
    _latestObservation = {
      balanceWei: balance,
      gasPriceWei: gasPrice,
      ts: Date.now(),
    };
    return computeGasStatus({
      balanceWei: balance,
      gasPriceWei: gasPrice,
      positionCount,
    });
  } catch (err) {
    console.warn("[gas-monitor] getGasStatus failed: %s", err.message);
    return null;
  }
}

/**
 * Check wallet gas balance and send a Telegram alert when the tier
 * drops to 'low' or 'critical'.  Also updates the singleton observation
 * so the dashboard can surface the tier without a second RPC roundtrip.
 *
 * @param {object} opts
 * @param {object} opts.provider
 * @param {string} opts.address
 * @param {object} opts.position               Position info for the alert label.
 * @param {{alerted: boolean}} opts.alertState Persists across poll cycles.
 * @param {() => number} [opts.getPositionCount]  Defaults to () => 1.
 * @returns {Promise<void>}
 */
async function checkGasBalance(opts) {
  const { provider, address, position, alertState, getPositionCount } = opts;
  if (!provider || !address) return;
  const positionCount =
    typeof getPositionCount === "function" ? getPositionCount() : 1;
  const status = await getGasStatus({ provider, address, positionCount });
  if (!status) return;
  if (status.level === "ok") {
    if (alertState.alerted) {
      alertState.alerted = false;
      console.log(
        "[gas-monitor] Gas balance recovered above recommended threshold (%s native)",
        _formatNative(status.recommendedWei),
      );
    }
    return;
  }
  if (alertState.alerted) return;
  alertState.alerted = true;
  const balEth = _formatNative(status.balanceWei);
  const recEth = _formatNative(status.recommendedWei);
  const floorEth = _formatNative(status.floorWei);
  console.warn(
    "[gas-monitor] Gas %s: balance=%s recommended=%s floor=%s positions=%d",
    status.level.toUpperCase(),
    balEth,
    recEth,
    floorEth,
    status.positionCount,
  );
  notify("lowGasBalance", {
    position: {
      tokenId: position?.tokenId,
      token0Symbol: position?.token0Symbol,
      token1Symbol: position?.token1Symbol,
    },
    message:
      status.level === "critical"
        ? `CRITICAL: balance ${balEth} below one-rebalance floor ${floorEth}. Next rebalance will fail — top up now (recommended ${recEth} for ${status.positionCount} positions).`
        : `Balance ${balEth} below recommended ${recEth} (${status.positionCount} positions × 3× safety). Top up to avoid missed rebalances.`,
  });
}

/** Return the latest singleton observation, or null if none yet. */
function getLatestObservation() {
  return _latestObservation;
}

/**
 * Build the UI-ready gas status payload from the latest singleton
 * observation, the current managed-position count, and an async native
 * USD price fetcher. Returns null if no observation has been recorded
 * yet (e.g. no positions are running).
 *
 * @param {object} opts
 * @param {number} opts.positionCount
 * @param {(wei: bigint) => Promise<number>} opts.toUsd  Converts wei to USD.
 * @returns {Promise<object|null>}
 */
async function buildGasStatusPayload({ positionCount, toUsd }) {
  const obs = _latestObservation;
  if (!obs) return null;
  const status = computeGasStatus({
    balanceWei: obs.balanceWei,
    gasPriceWei: obs.gasPriceWei,
    positionCount,
  });
  const [balanceUsd, recommendedUsd, floorUsd] = await Promise.all([
    toUsd(status.balanceWei).catch(() => 0),
    toUsd(status.recommendedWei).catch(() => 0),
    toUsd(status.floorWei).catch(() => 0),
  ]);
  return {
    level: status.level,
    positionCount: status.positionCount,
    balanceNative: Number(status.balanceWei) / 1e18,
    recommendedNative: Number(status.recommendedWei) / 1e18,
    floorNative: Number(status.floorWei) / 1e18,
    balanceUsd,
    recommendedUsd,
    floorUsd,
    gasPriceGwei: Number(status.gasPriceWei) / 1e9,
    observedAt: obs.ts,
  };
}

/** Format a wei BigInt as a human-readable native token string. */
function _formatNative(wei) {
  const f = Number(wei) / 1e18;
  return f < 0.01 ? f.toExponential(2) : f.toFixed(4);
}

module.exports = {
  checkGasBalance,
  computeGasStatus,
  getGasStatus,
  getLatestObservation,
  buildGasStatusPayload,
  WORST_CASE_GAS_FACTOR,
  SAFETY_MULTIPLIER,
  SEND_GAS,
  _formatNative,
};
