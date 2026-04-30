/**
 * @file src/send-transaction.js
 * @module send-transaction
 * @description
 * Single TX-submission entry point for the entire app.  Bundles:
 *   - estimateGas with chain-config gas-limit multiplier and per-call floor
 *   - mid-session RPC failover (one fallback RPC, sticky for FAILOVER_DURATION_MS)
 *   - retry on transient RPC errors (delegated to ./tx-retry._retrySend)
 *   - automatic speed-up of pending TXs after TX_SPEEDUP_SEC
 *   - automatic cancel via 0-PLS self-transfer after TX_CANCEL_SEC
 *
 * Public API:
 *   - init(rpcConfig)         — call once at boot from bot-loop.js
 *   - sendTransaction(opts)   — every TX-sending path in the app
 *   - getCurrentRPC()         — provider currently in use (consulted by
 *                               nonce-manager-wrapper to keep the
 *                               singleton NonceManager bound to the
 *                               active RPC)
 *   - failoverToNextRPC()     — switch to the fallback RPC for the next
 *                               FAILOVER_DURATION_MS (sticky window).
 *                               Idempotent within the window.
 *
 * Encapsulation: this module owns the primary/fallback provider pair.
 * Callers pass the raw `chain.rpc` JSON; provider construction stays here.
 *
 * RPC-failover scope: estimateGas-failover works with ANY signer because
 * `sendTransaction` performs the estimate against `getCurrentRPC()`
 * directly.  Broadcast-failover (re-routing the signed TX to the
 * fallback) requires the signer to be a `FailoverNonceManager` from
 * `./nonce-manager-wrapper.js`, which consults `getCurrentRPC()` on
 * every method call.  A plain `ethers.NonceManager` will continue to
 * use the boot provider for the broadcast even after failover.
 */

"use strict";

const ethers = require("ethers");
const config = require("./config");
const { buildProvider } = require("./bot-provider");
const { _retrySend } = require("./tx-retry");

/**
 * How long a single failover stays sticky before we try the primary again.
 * One hour: long enough to ride out a sustained RPC outage, short enough
 * that a transient blip doesn't pin us to the (typically slower) fallback
 * for the rest of the bot's lifetime.  Module-internal — not exported.
 */
const FAILOVER_DURATION_MS = 60 * 60 * 1000;

/** Default gas-limit multiplier when chain config doesn't set one. */
const _DEFAULT_GAS_LIMIT_MULTIPLIER = 2;
/** Default speed-up gas-price bump when chain config doesn't set one. */
const _DEFAULT_SPEEDUP_GAS_BUMP = 1.5;
/** Default gasLimit floor for callers that omit one. Sized so plain
 *  contract calls don't OOG on the worst tier we've observed. */
const _DEFAULT_FLOOR = 300_000n;
/** Cancel TX is a 0-value self-transfer — exactly 21000 base gas. */
const _CANCEL_GAS_LIMIT = 21000n;

let _primaryProvider = null;
let _fallbackProvider = null;
let _primaryUrl = null;
let _fallbackUrl = null;
let _useFallbackUntilMs = 0;

/**
 * Register the chain's RPC providers.  Call once at boot.
 *
 * Both providers are constructed eagerly via `bot-provider.buildProvider`
 * (which applies the feeData patch) regardless of boot-time reachability —
 * the whole point of mid-session failover is that the fallback must be
 * usable at the moment the primary fails, possibly hours after boot.
 *
 * @param {{primary: string, fallback: string}} rpcConfig
 *   Raw `chain.rpc` JSON from app-config/static-tunables/chains.json.
 * @param {object} [ethersLib]  Injected ethers library (for testing).
 */
function init(rpcConfig, ethersLib) {
  if (!rpcConfig || !rpcConfig.primary || !rpcConfig.fallback) {
    throw new Error(
      "[send-tx] init: rpcConfig must have { primary, fallback } URL strings",
    );
  }
  _primaryUrl = rpcConfig.primary;
  _fallbackUrl = rpcConfig.fallback;
  _primaryProvider = buildProvider(rpcConfig.primary, ethersLib || ethers);
  _fallbackProvider = buildProvider(rpcConfig.fallback, ethersLib || ethers);
  _useFallbackUntilMs = 0;
}

/**
 * Provider currently in use.  Returns the fallback iff we're inside an
 * active failover window; otherwise the primary.  When the window expires
 * we automatically revert to primary on the next call — self-healing.
 *
 * Throws if `init()` hasn't run yet, to prevent silent un-routed TX sends.
 * @returns {import('ethers').JsonRpcProvider}
 */
function getCurrentRPC() {
  if (!_primaryProvider) {
    throw new Error(
      "[send-tx] getCurrentRPC: not initialized — call init() at boot first",
    );
  }
  if (Date.now() < _useFallbackUntilMs) return _fallbackProvider;
  return _primaryProvider;
}

/**
 * Engage a sticky failover to the fallback RPC for FAILOVER_DURATION_MS.
 *
 * Called by `sendTransaction` when an estimateGas attempt against the
 * current RPC fails but succeeds against the fallback, and by the
 * NonceManager wrapper when its underlying RPC throws.  Idempotent: a
 * second call inside the window simply refreshes the timer.
 *
 * No-op when primary URL === fallback URL (single-RPC chains like the
 * current PulseChain testnet config).
 */
function failoverToNextRPC() {
  if (!_primaryProvider) {
    throw new Error(
      "[send-tx] failoverToNextRPC: not initialized — call init() at boot first",
    );
  }
  if (_primaryUrl === _fallbackUrl) {
    /*- Same-URL config (e.g. current testnet entry).  Failing over would
        achieve nothing; silently no-op so callers don't need to know
        whether their chain has two distinct RPCs. */
    return;
  }
  const wasActive = Date.now() < _useFallbackUntilMs;
  _useFallbackUntilMs = Date.now() + FAILOVER_DURATION_MS;
  if (!wasActive) {
    console.warn(
      "[send-tx] RPC failover engaged: %s → %s (sticky for %d min)",
      _primaryUrl,
      _fallbackUrl,
      Math.round(FAILOVER_DURATION_MS / 60_000),
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Unwrap a NonceManager (or FailoverNonceManager) to the base signer.
 * Replacement and cancel TXs explicitly reuse a stuck nonce, so they
 * MUST bypass the NonceManager (which would otherwise overwrite the
 * nonce field with its own counter).
 */
function _baseSigner(signer) {
  return signer.signer ?? signer;
}

/** Re-sync NonceManager after a cancel so its counter matches chain state. */
function _resetNonce(signer) {
  if (typeof signer.reset === "function") signer.reset();
}

/** Extract gas cost in wei from a TX receipt. */
function _receiptGas(rcpt) {
  return (rcpt.gasUsed ?? 0n) * (rcpt.gasPrice ?? rcpt.effectiveGasPrice ?? 0n);
}

/**
 * Compute a cancel gas price that beats the stuck replacement TX.
 * Uses 2× the higher of current network gas or the stuck TX's gas.
 */
async function _cancelGasPrice(provider, stuckGas) {
  const fd = await provider.getFeeData();
  const cur = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
  const base = cur > stuckGas ? cur : stuckGas;
  return base * 2n;
}

/**
 * estimateGas against the current RPC, falling back to the alternate
 * RPC once if the current fails.  When the alternate succeeds we
 * engage `failoverToNextRPC()` so subsequent operations (broadcast,
 * receipts, nonce lookups) also go through the alternate for the
 * sticky-window duration.
 *
 * Only PRIMARY → FALLBACK failover is supported (the user's spec).
 * If we're already on fallback and fallback fails, we throw the
 * fallback error — there's no further alternate to try.
 *
 * @returns {Promise<bigint>} estimated gas units.
 */
async function _estimateWithFailover(populated, label) {
  const cur = getCurrentRPC();
  try {
    return await cur.estimateGas(populated);
  } catch (curErr) {
    const onPrimary = cur === _primaryProvider;
    if (!onPrimary || _primaryUrl === _fallbackUrl) throw curErr;
    console.warn(
      "[send-tx] %s: estimateGas on primary failed — trying fallback. Inner: %s",
      label,
      curErr.shortMessage || curErr.message,
    );
    try {
      const gas = await _fallbackProvider.estimateGas(populated);
      failoverToNextRPC();
      return gas;
    } catch (fbErr) {
      console.warn(
        "[send-tx] %s: estimateGas on fallback also failed — using floor. Inner: %s",
        label,
        fbErr.shortMessage || fbErr.message,
      );
      throw curErr;
    }
  }
}

/**
 * Resolve the gasLimit for a populated TX request.
 *
 * Decision tree:
 *   1. populated.gasLimit set → use as-is (caller knows exactly what it wants).
 *   2. estimateGas succeeds → max(estimate × multiplier, floor).
 *   3. both estimates fail → floor.
 *
 * The chain-config multiplier (`config.CHAIN.gasLimitMultiplier`) is
 * applied with millis-precision so non-integer values like 1.5× work.
 */
async function _resolveGasLimit(populated, floor, label) {
  if (populated.gasLimit !== undefined && populated.gasLimit !== null) {
    return BigInt(populated.gasLimit);
  }
  const mult =
    config.CHAIN?.gasLimitMultiplier ?? _DEFAULT_GAS_LIMIT_MULTIPLIER;
  try {
    const estimate = await _estimateWithFailover(populated, label);
    const buffered = (estimate * BigInt(Math.round(mult * 1000))) / 1000n;
    const final = buffered > floor ? buffered : floor;
    console.log(
      "[send-tx] %s: estimate=%s × %sx → %s (floor %s)",
      label,
      String(estimate),
      String(mult),
      String(final),
      String(floor),
    );
    return final;
  } catch (err) {
    console.warn(
      "[send-tx] %s: estimateGas failed on both RPCs — using floor %s. Inner: %s",
      label,
      String(floor),
      err.shortMessage || err.message,
    );
    return floor;
  }
}

// ── Speed-up + cancel pipeline ───────────────────────────────────────────────

/** Wrap tx.wait() to surface the receipt of a TRANSACTION_REPLACED event. */
function _tolerantWait(tx, label) {
  return tx.wait().catch((e) => {
    if (e.code === "TRANSACTION_REPLACED" && e.receipt) {
      console.log(
        "[send-tx] %s: TX replaced, using replacement receipt",
        label,
      );
      return e.receipt;
    }
    throw e;
  });
}

/** Promise that rejects after `ms` with the given sentinel message. */
function _timeout(ms, sentinel) {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(sentinel)), ms);
    t.unref?.();
  });
}

/** Coerce whatever Promise.race returned into a TransactionReceipt. */
function _extractReceipt(result) {
  if (result && result._type === "TransactionReceipt") return result;
  if (result && result.receipt) return result.receipt;
  return result;
}

/**
 * Submit a speed-up replacement at the same nonce with a bumped gas price.
 * Returns the replacement TransactionResponse, or null when the original
 * has already been mined (so there's nothing to replace).
 */
async function _submitSpeedUp(tx, signer, label) {
  const provider = signer.provider || signer;
  const fd = await provider.getFeeData();
  const curGas = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
  const origGas = tx.gasPrice ?? tx.maxFeePerGas ?? 0n;
  const bump = config.CHAIN?.speedUpGasBump ?? _DEFAULT_SPEEDUP_GAS_BUMP;
  const bumped = BigInt(
    Math.ceil(Number(curGas > origGas ? curGas : origGas) * bump),
  );
  console.log(
    "[send-tx] %s: speedup origGas=%s curGas=%s bumped=%s nonce=%d",
    label,
    String(origGas),
    String(curGas),
    String(bumped),
    tx.nonce,
  );
  try {
    const replacement = await _retrySend(
      () =>
        _baseSigner(signer).sendTransaction({
          type: config.TX_TYPE,
          to: tx.to,
          data: tx.data,
          value: tx.value,
          nonce: tx.nonce,
          gasLimit: tx.gasLimit,
          gasPrice: bumped,
        }),
      "[send-tx] " + label + " speedup nonce=" + tx.nonce,
      { signer, retryingTxWithSameNonce: true },
    );
    console.log(
      "[send-tx] %s: replacement TX submitted, hash=%s nonce=%d",
      label,
      replacement.hash,
      replacement.nonce,
    );
    return replacement;
  } catch (sendErr) {
    console.error(
      "[send-tx] %s: speed-up send failed (nonce=%d): %s — waiting for original",
      label,
      tx.nonce,
      sendErr.message,
    );
    return null;
  }
}

/**
 * Cancel a stuck nonce with a 0-PLS self-transfer at a beat-everyone gas
 * price.  Throws an Error annotated with `cancelled: true` so the caller
 * can distinguish "TX cancelled, retry" from "TX failed, abort".
 */
async function _cancelStuckNonce(
  tx,
  signer,
  label,
  replacement,
  bumped,
  totalMin,
) {
  const provider = signer.provider || signer;
  console.error(
    "[send-tx] %s: TX STILL STUCK after %d min — cancelling nonce %d with 0-PLS self-transfer",
    label,
    totalMin,
    tx.nonce,
  );
  const cancelGas = await _cancelGasPrice(
    provider,
    replacement?.gasPrice ?? bumped ?? 0n,
  );
  const base = _baseSigner(signer);
  const addr = await base.getAddress();
  const cancelTx = await _retrySend(
    () =>
      base.sendTransaction({
        type: config.TX_TYPE,
        to: addr,
        value: 0,
        nonce: tx.nonce,
        gasPrice: cancelGas,
        gasLimit: _CANCEL_GAS_LIMIT,
      }),
    "[send-tx] " + label + " cancel nonce=" + tx.nonce,
    { signer: base, retryingTxWithSameNonce: true },
  );
  console.log(
    "[send-tx] %s: cancel TX submitted, hash=%s nonce=%d gasPrice=%s",
    label,
    cancelTx.hash,
    cancelTx.nonce,
    String(cancelGas),
  );
  const cancelReceipt = await cancelTx.wait();
  console.log(
    "[send-tx] %s: cancel TX confirmed in block %d — nonce %d is now free",
    label,
    cancelReceipt.blockNumber,
    tx.nonce,
  );
  _resetNonce(signer);
  const cancelErr = new Error(
    "Transaction cancelled after " +
      totalMin +
      " min (nonce " +
      tx.nonce +
      " freed via 0-PLS self-transfer)",
  );
  cancelErr.cancelled = true;
  cancelErr.cancelTxHash = cancelTx.hash;
  cancelErr.cancelGasCostWei = _receiptGas(cancelReceipt);
  throw cancelErr;
}

/**
 * Wait for a TX to confirm, automatically speeding it up after
 * TX_SPEEDUP_SEC and cancelling after TX_CANCEL_SEC.
 *
 * Four phases:
 *   1. wait up to TX_SPEEDUP_SEC for the original.
 *   2. submit a speed-up replacement at the same nonce + bumped gas.
 *   3. wait up to total TX_CANCEL_SEC for either to confirm.
 *   4. cancel the stuck nonce with a 0-PLS self-transfer.
 */
async function _waitOrSpeedUp(tx, signer, label) {
  const speedupMs = (config.TX_SPEEDUP_SEC || 120) * 1000;
  const cancelMs = (config.TX_CANCEL_SEC || 1200) * 1000;
  const startTime = Date.now();

  /*- Phase 1: wait for confirmation, or fall through to speed-up. */
  try {
    const receipt = await Promise.race([
      _tolerantWait(tx, label),
      _timeout(speedupMs, "_SPEEDUP"),
    ]);
    return _extractReceipt(receipt);
  } catch (err) {
    if (err.message !== "_SPEEDUP") throw err;
  }

  /*- Phase 2: submit the speed-up replacement. */
  console.warn(
    "[send-tx] %s: TX %s not confirmed after %ds — speeding up",
    label,
    tx.hash,
    speedupMs / 1000,
  );
  const replacement = await _submitSpeedUp(tx, signer, label);
  if (!replacement) {
    /*- Speed-up send failed — fall back to waiting for the original.
        Common case: the original confirmed between phases 1 and 2,
        so the same-nonce replacement is rejected as "nonce too low". */
    return _extractReceipt(await _tolerantWait(tx, label));
  }

  /*- Phase 3: wait for either to confirm, or fall through to cancel. */
  const elapsed = Date.now() - startTime;
  const cancelIn = Math.max(10_000, cancelMs - elapsed);
  try {
    const receipt = await Promise.race([
      _tolerantWait(tx, label),
      _tolerantWait(replacement, label),
      _timeout(cancelIn, "_CANCEL"),
    ]);
    return _extractReceipt(receipt);
  } catch (err) {
    if (err.message !== "_CANCEL") throw err;
  }

  /*- Phase 4: cancel the stuck nonce. Always throws (cancelled or fail). */
  const totalMin = Math.round((Date.now() - startTime) / 60_000);
  try {
    await _cancelStuckNonce(
      tx,
      signer,
      label,
      replacement,
      replacement?.gasPrice ?? 0n,
      totalMin,
    );
    /*- Unreachable: _cancelStuckNonce always throws. */
    return null;
  } catch (cancelErr) {
    if (cancelErr.cancelled) throw cancelErr;
    console.error(
      "[send-tx] %s: cancel TX failed: %s — nonce %d may still be stuck",
      label,
      cancelErr.message,
      tx.nonce,
    );
    throw new Error("TX stuck and cancel failed: " + cancelErr.message, {
      cause: cancelErr,
    });
  }
}

// ── Public sendTransaction ───────────────────────────────────────────────────

/**
 * Send a transaction with the unified policy: estimate-with-failover,
 * gasLimit floor, retry on transient errors, automatic speed-up + cancel.
 *
 * @param {object} opts
 * @param {() => Promise<object>} opts.populate
 *   Async fn returning a populated TX request (no signing yet).  The
 *   typical pattern is `() => contract.method.populateTransaction(args)`,
 *   but raw `{ to, value, data, ... }` works too.  If the populated
 *   request includes `gasLimit`, it's used as-is (estimate is skipped).
 * @param {import('ethers').Signer} opts.signer
 *   Signer that will broadcast the TX.  For full RPC failover (estimate
 *   AND broadcast), pass a `FailoverNonceManager`.  A plain
 *   `ethers.NonceManager` gets estimate failover only.
 * @param {bigint|number} [opts.floor]
 *   gasLimit floor.  Default: 300000n.  Use a higher floor for known
 *   gas-heavy paths (e.g. mint via `config.CHAIN.contracts.positionManager.mintGasLimit`).
 *   Use 21000n for plain value transfers (cancel TXs).
 * @param {string} [opts.label]
 *   Log prefix.  Defaults to "send-tx".
 * @returns {Promise<{tx: import('ethers').TransactionResponse,
 *                    receipt: import('ethers').TransactionReceipt}>}
 */
async function sendTransaction(opts) {
  if (!opts || typeof opts.populate !== "function") {
    throw new Error(
      "[send-tx] sendTransaction: opts.populate must be a function",
    );
  }
  if (!opts.signer) {
    throw new Error("[send-tx] sendTransaction: opts.signer is required");
  }
  const label = opts.label || "send-tx";
  const floor =
    typeof opts.floor === "bigint"
      ? opts.floor
      : opts.floor !== undefined && opts.floor !== null
        ? BigInt(opts.floor)
        : _DEFAULT_FLOOR;

  const populated = await opts.populate();
  if (!populated.from) {
    populated.from = await opts.signer.getAddress();
  }

  const gasLimit = await _resolveGasLimit(populated, floor, label);

  const txReq = { ...populated, gasLimit };
  /*- Default to chain-configured TX type (legacy on PulseChain) unless
      the caller already pinned one. */
  if (txReq.type === undefined) txReq.type = config.TX_TYPE;

  const tx = await _retrySend(
    () => opts.signer.sendTransaction(txReq),
    "[send-tx] " + label,
    { signer: opts.signer },
  );
  console.log(
    "[send-tx] %s: TX submitted, hash=%s nonce=%d gasLimit=%s gasPrice=%s",
    label,
    tx.hash,
    tx.nonce,
    String(tx.gasLimit ?? "—"),
    String(tx.gasPrice ?? tx.maxFeePerGas ?? "—"),
  );

  const receipt = await _waitOrSpeedUp(tx, opts.signer, label);
  console.log(
    "[send-tx] %s: confirmed, gasUsed=%s gasPrice=%s block=%s",
    label,
    String(receipt.gasUsed),
    String(receipt.gasPrice ?? receipt.effectiveGasPrice),
    receipt.blockNumber,
  );
  return { tx, receipt };
}

/*- Test-only reset.  No production caller — exists so unit tests can
    re-init with different rpcConfig shapes without leaking module state. */
function _resetForTests() {
  _primaryProvider = null;
  _fallbackProvider = null;
  _primaryUrl = null;
  _fallbackUrl = null;
  _useFallbackUntilMs = 0;
}

module.exports = {
  init,
  sendTransaction,
  getCurrentRPC,
  failoverToNextRPC,
  /*- Internal helpers exposed for tests in test/send-transaction.test.js. */
  _resolveGasLimit,
  _estimateWithFailover,
  _waitOrSpeedUp,
  _resetForTests,
};
