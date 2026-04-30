/**
 * @file src/nonce-manager-wrapper.js
 * @module nonce-manager-wrapper
 * @description
 * Failover-aware NonceManager.
 *
 * Wraps a base `ethers.Wallet` and consults
 * `send-transaction.getCurrentRPC()` lazily on every operation so that
 * when the active RPC flips (via `failoverToNextRPC()`), the very next
 * call is automatically routed through the new provider — no caller
 * needs to know failover happened.
 *
 * Two layers of behaviour:
 *
 *   1. **Lazy rebind** — `_sync()` checks the current RPC URL on every
 *      call.  If it changed since the last call, we discard the
 *      previous `ethers.NonceManager` and build a fresh one wrapping
 *      `_baseWallet.connect(activeProvider)`.  The fresh NonceManager
 *      starts with `#delta = 0` and re-fetches the on-chain nonce on
 *      first use, so a freshly-bound fallback never inherits a stale
 *      delta from the dead primary.
 *
 *   2. **Broadcast failover** — `sendTransaction` catches transient RPC
 *      errors (per `rpc-error-classifier.classifyRpcError`) and retries
 *      ONCE on the alternate RPC.  Terminal errors (nonce-consumed,
 *      nonce-unused, unknown) bubble up unchanged — they're not
 *      RPC-availability problems.  No retry when we're already on the
 *      fallback (single-URL chains, or active failover window already).
 *
 * Compatibility shape: this class is duck-typed as an ethers v6 Signer.
 * It exposes `provider`, `signer`, `getAddress`, `getNonce`,
 * `populateTransaction`, `estimateGas`, `call`, `resolveName`,
 * `signTransaction`, `signMessage`, `signTypedData`, `sendTransaction`,
 * `connect`, `reset`, `increment` — every method the codebase or
 * `ethers.Contract` uses on a `NonceManager`.
 *
 * The `.signer` getter returns the inner wallet (matching
 * `ethers.NonceManager.signer` semantics) so the existing
 * `_baseSigner(s) = s.signer ?? s` unwrap pattern in send-transaction
 * keeps working for explicit-nonce TXs (speed-up / cancel) that must
 * bypass nonce management.
 */

"use strict";

const ethers = require("ethers");
const sendTx = require("./send-transaction");
const { classifyRpcError } = require("./rpc-error-classifier");

/**
 * Read a JsonRpcProvider's URL via the two attribute names ethers has
 * used across versions.  Used only for log messages — internal
 * tracking compares provider object identity (more reliable in test
 * stubs where URLs may be undefined).
 */
function _providerUrl(provider) {
  return provider?._url ?? provider?.connection?.url ?? null;
}

/**
 * Failover-aware wrapper around `ethers.NonceManager`.
 *
 * Construct once per app boot with the user's `ethers.Wallet`; pass the
 * resulting instance everywhere the code currently passes a plain
 * `ethers.NonceManager`.
 */
class FailoverNonceManager {
  /**
   * @param {import('ethers').Wallet} baseWallet
   *   Plain wallet (private key + provider).  The wrapper will reconnect
   *   it to the active RPC on every `_sync`, so the provider it was
   *   originally constructed with does not matter.
   * @param {object} [opts]
   * @param {object} [opts.ethersLib]  Injected ethers (for tests).
   */
  constructor(baseWallet, opts) {
    this._baseWallet = baseWallet;
    this._ethersLib = (opts && opts.ethersLib) || ethers;
    /*- Track the inner-NM's provider by object identity, not URL.
        send-transaction holds primary + fallback as fixed instances;
        getCurrentRPC() flips between them, so identity-equality is the
        reliable signal that the active RPC has actually changed. */
    this._lastProvider = null;
    this._inner = null;
    /*- Construct the inner NonceManager eagerly so callers immediately
        see one full ethers.NonceManager per FailoverNonceManager (the
        shared-signer-singleton contract that fixed the 2026-04-24 nonce
        storm).  Requires sendTx.init() to have been called first —
        callers that get this wrong will see a clear "not initialized"
        error from getCurrentRPC() rather than silently no-oping. */
    this._sync();
  }

  /**
   * Ensure `this._inner` points at an `ethers.NonceManager` bound to
   * the currently-active RPC.  Rebuilds only when the active provider
   * instance has changed.
   * @returns {import('ethers').NonceManager}
   */
  _sync() {
    const provider = sendTx.getCurrentRPC();
    if (this._lastProvider !== provider) {
      this._lastProvider = provider;
      const wallet = this._baseWallet.connect(provider);
      this._inner = new this._ethersLib.NonceManager(wallet);
    }
    return this._inner;
  }

  /** Provider in current use.  Read by `ethers.Contract` for read calls. */
  get provider() {
    return this._sync().provider;
  }

  /**
   * The inner wallet — matches `ethers.NonceManager.signer` semantics.
   * Used by speed-up / cancel TXs that explicitly reuse a stuck nonce
   * and must bypass nonce management.
   */
  get signer() {
    return this._sync().signer;
  }

  /** Address — delegates to the inner NonceManager, which in turn
   *  reads from the wrapped wallet.  No network call. */
  async getAddress() {
    return this._sync().getAddress();
  }

  /**
   * `connect(provider)` is part of the ethers Signer contract.  We
   * intentionally ignore the passed provider — `getCurrentRPC()` is the
   * single source of truth for which RPC we use.  Returning `this`
   * keeps existing call sites working without surprising them.
   */
  connect() {
    return this;
  }

  /** Reset the internal nonce delta (re-fetch from chain on next call). */
  reset() {
    if (this._inner) this._inner.reset();
  }

  /** Manually advance the nonce delta. */
  increment() {
    if (this._inner) this._inner.increment();
  }

  /** Pending-nonce lookup, routed through the active RPC. */
  async getNonce(blockTag) {
    return this._sync().getNonce(blockTag);
  }

  /** Populate a TX request (fills nonce, gasLimit, chainId). */
  async populateTransaction(tx) {
    return this._sync().populateTransaction(tx);
  }

  /** Populate a read-only call. */
  async populateCall(tx) {
    return this._sync().populateCall(tx);
  }

  /** Estimate gas via the active RPC.  No retry — `_estimateWithFailover`
   *  in send-transaction handles estimate failover at a higher layer. */
  async estimateGas(tx) {
    return this._sync().estimateGas(tx);
  }

  /** Read-only call. */
  async call(tx) {
    return this._sync().call(tx);
  }

  /** ENS resolver (rarely used in this codebase). */
  async resolveName(name) {
    return this._sync().resolveName(name);
  }

  /** Sign a TX without broadcasting.  No RPC needed. */
  async signTransaction(tx) {
    return this._sync().signTransaction(tx);
  }

  /** Sign a message (EIP-191).  No RPC needed. */
  async signMessage(message) {
    return this._sync().signMessage(message);
  }

  /** Sign typed data (EIP-712).  No RPC needed. */
  async signTypedData(domain, types, value) {
    return this._sync().signTypedData(domain, types, value);
  }

  /**
   * Broadcast a TX.  On a transient RPC error, engage `failoverToNextRPC()`
   * and retry exactly once on the alternate provider.  Terminal errors
   * bubble up unchanged.
   *
   * No retry when the failover call doesn't actually change the active
   * provider (single-URL chain or already-engaged failover window) —
   * retrying on the same provider would just produce the same failure.
   */
  async sendTransaction(tx) {
    const before = sendTx.getCurrentRPC();
    try {
      return await this._sync().sendTransaction(tx);
    } catch (err) {
      if (classifyRpcError(err) !== "transient") throw err;
      sendTx.failoverToNextRPC();
      const after = sendTx.getCurrentRPC();
      if (before === after) throw err;
      console.warn(
        "[failover-nm] sendTransaction transient error on %s — retrying on %s. Inner: %s",
        _providerUrl(before),
        _providerUrl(after),
        err.shortMessage || err.message,
      );
      /*- Rebind to the new active provider.  The fresh NonceManager
          starts with delta=0 and will fetch a fresh chain-state nonce
          on the retry — exactly what we want after the previous send
          failed before broadcast. */
      return await this._sync().sendTransaction(tx);
    }
  }
}

/**
 * Convenience factory — most callers prefer a function over a `new`.
 * @param {import('ethers').Wallet} baseWallet
 * @param {object} [opts]
 * @returns {FailoverNonceManager}
 */
function createFailoverSigner(baseWallet, opts) {
  return new FailoverNonceManager(baseWallet, opts);
}

module.exports = { FailoverNonceManager, createFailoverSigner };
