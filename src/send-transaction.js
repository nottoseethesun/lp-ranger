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

const { log } = require("./log");
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

/*- The ordered RPC list and where in it we currently are.
 *
 *  This was a primary/fallback pair.  It is a list because chains.json
 *  now ships an ordered set (see `rpc.urls`), and "the fallback" is no
 *  longer a single thing: failover walks forward through the list.
 *
 *  `_stickyUntilMs` is the deadline for the current non-zero position.
 *  Once it passes, `getCurrentRPC` snaps back to index 0 — the same
 *  self-healing behaviour the pair had, generalised. */
let _providers = [];
let _urls = [];
let _activeIdx = 0;
let _stickyUntilMs = 0;

/**
 * Register the chain's RPC providers.  Idempotent: safe to call from
 * multiple boot paths (server.js, bot-loop.js, position-manager.js).  A
 * second call with the SAME URLs is a no-op; a second call with DIFFERENT
 * URLs throws — the process can only have one active RPC pair at a time.
 *
 * Both providers are constructed eagerly via `bot-provider.buildProvider`
 * (which applies the feeData patch) regardless of boot-time reachability —
 * the whole point of mid-session failover is that the fallback must be
 * usable at the moment the primary fails, possibly hours after boot.
 *
 * @param {{urls: string[]}} rpcConfig
 *   Ordered RPC URLs, most-preferred first.  Callers pass the
 *   env-var-aware `{ urls: config.RPC_URLS }` so an operator's `.env`
 *   override is honoured for both reads and writes.
 * @param {object} [ethersLib]  Injected ethers library (for testing).
 */
function init(rpcConfig, ethersLib) {
  const urls = rpcConfig && rpcConfig.urls;
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every(Boolean)) {
    throw new Error(
      "[send-tx] init: rpcConfig must have { urls: [...] } — a non-empty ordered array of URL strings",
    );
  }
  if (_providers.length > 0) {
    if (_urls.length === urls.length && _urls.every((u, i) => u === urls[i])) {
      /*- Already initialised with matching URLs.  Keep the existing
       *  providers AND the sticky window so a re-init mid-outage
       *  doesn't accidentally revert to a known-broken endpoint. */
      return;
    }
    throw new Error(
      "[send-tx] init: already initialised with different URLs " +
        `(was ${_urls.join(", ")}, now ${urls.join(", ")})`,
    );
  }
  _urls = [...urls];
  _providers = _urls.map((u) => buildProvider(u, ethersLib || ethers));
  _activeIdx = 0;
  _stickyUntilMs = 0;
}

/**
 * How many endpoints are actually available to move between.
 *
 * Replaces the `_primaryUrl === _fallbackUrl` check that used to appear
 * at five separate call sites.  A chain configured with one endpoint
 * (the testnet ships exactly that) cannot fail over, and every caller
 * needs to know it without re-deriving the rule.
 * @returns {number}
 */
function _endpointCount() {
  return _urls.length;
}

/*- Error codes / response statuses that indicate the active RPC is the
 *  problem (rather than the request).  Match the shapes ethers v6
 *  surfaces for upstream/CDN failures we observed in production logs
 *  (Cloudflare 502 / 522, network timeouts, server-side errors). */
const _READ_FAILOVER_CODES = new Set([
  "SERVER_ERROR",
  "TIMEOUT",
  "NETWORK_ERROR",
]);

function _isReadFailoverable(err) {
  if (!err) return false;
  if (err.code && _READ_FAILOVER_CODES.has(err.code)) return true;
  const status = err.info && err.info.responseStatus;
  if (status && /^5\d\d/.test(String(status))) return true;
  return false;
}

/**
 * Boot-time reachability probe for the primary RPC.  Calls
 * `primary.getBlockNumber()`; if it throws, engages `failoverToNextRPC()`
 * and verifies that `fallback.getBlockNumber()` succeeds.  Replaces the
 * boot check that previously lived in `bot-provider.createProviderWithFallback`,
 * but now reports the result through the shared `getCurrentRPC` state so
 * subsequent reads (via `getManagedReadProvider`) and writes go to the
 * same RPC.
 *
 * Idempotent: a second call when the sticky-failover window is active
 * simply re-probes the primary and lets `failoverToNextRPC()` extend
 * the window if the primary is still down.
 *
 * Throws if `init()` hasn't run yet, or if BOTH primary AND fallback
 * are unreachable.
 *
 * @returns {Promise<void>}
 */
async function ensureReachable() {
  if (_providers.length === 0) {
    throw new Error(
      "[send-tx] ensureReachable: not initialised — call init() at boot first",
    );
  }
  /*- Try each endpoint in order until one answers.  The error that
   *  surfaces when none does is the LAST one, which is the most useful:
   *  it names the endpoint we gave up on rather than the one we started
   *  with. */
  let lastErr = null;
  for (let i = 0; i < _providers.length; i++) {
    try {
      await _providers[i].getBlockNumber();
      if (i > 0) {
        /*- Engage the sticky window so reads and writes both start on
         *  the endpoint we just proved reachable, rather than retrying
         *  the dead one on the first real call. */
        _engageFailoverTo(i, 0);
        log.info(`[bot] RPC:    ${_urls[i]} (fallback)`);
      } else {
        log.info(`[bot] RPC:    ${_urls[i]}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      const more = i < _providers.length - 1;
      log.warn(`[bot] RPC unreachable (${_urls[i]}): ${err.message}`);
      if (more) log.info(`[bot] Falling back to ${_urls[i + 1]}`);
    }
  }
  throw lastErr;
}

/**
 * Return a `Proxy` that quacks like an ethers JsonRpcProvider but
 * resolves the underlying provider via `getCurrentRPC()` on every
 * property access — including method calls and the Contract internals
 * that go through `provider.call` / `provider.send`.  On a failover-
 * eligible async rejection, calls `failoverToNextRPC()` and retries
 * the same call once against the new active RPC.  This is the single
 * entry point for ALL read-side provider access in the app, so a
 * sustained primary outage produces exactly one read-failure log line
 * per call site and then everything follows the fallback for the
 * sticky window.
 *
 * Contracts constructed with the returned proxy automatically follow
 * failover, because ethers' Contract delegates every RPC call through
 * `provider.call` / `provider.send`, which the proxy intercepts.
 *
 * Does NOT itself throw before `init()` — the proxy is returned
 * unconditionally and the init-required check fires on first property
 * access (via `getCurrentRPC()`).  This defers the failure to the point
 * of use so callers that obtain the proxy without exercising it (a
 * common pattern in unit tests that stub the consumer) don't need a
 * full init.
 *
 * @returns {import('ethers').JsonRpcProvider}
 */
function getManagedReadProvider() {
  /*- Return the Proxy unconditionally — `getCurrentRPC()` will throw
   *  when the proxy is ACTUALLY USED if init() hasn't run yet.  This
   *  defers the failure to the point of use, which lets tests that
   *  obtain the proxy but never call into it (e.g. compounder unit
   *  tests that exercise the classifier with zero compound events)
   *  succeed without a full send-transaction init. */
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const current = getCurrentRPC();
        const val = current[prop];
        if (typeof val !== "function") return val;
        return function (...args) {
          const result = val.apply(current, args);
          /*- Sync return (rare for providers) — pass through. */
          if (!result || typeof result.then !== "function") return result;
          /*- Async — wrap with failover-on-error retry.  Only retry on
           *  shapes that indicate the RPC itself is the problem, not
           *  the request. */
          return Promise.resolve(result).catch(async (err) => {
            if (!_isReadFailoverable(err)) throw err;
            /*- `failoverToNextRPC` reports whether it actually moved.
             *  The old code inferred that from `next === current`, which
             *  only worked while there were exactly two endpoints —
             *  with three, "the provider changed" and "alternates
             *  remain" are different questions. */
            if (!failoverToNextRPC()) throw err;
            const next = getCurrentRPC();
            return await next[prop].apply(next, args);
          });
        };
      },
    },
  );
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
  if (_providers.length === 0) {
    throw new Error(
      "[send-tx] getCurrentRPC: not initialized — call init() at boot first",
    );
  }
  /*- Snap back to the preferred endpoint once the sticky window lapses.
   *  Done here, on read, rather than on a timer: there is no background
   *  work to cancel and no way for the reset to be missed. */
  if (_activeIdx !== 0 && Date.now() >= _stickyUntilMs) _activeIdx = 0;
  return _providers[_activeIdx];
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
  if (_providers.length === 0) {
    throw new Error(
      "[send-tx] failoverToNextRPC: not initialized — call init() at boot first",
    );
  }
  /*- Single-endpoint chain (the testnet ships one).  Nothing to move
   *  to; no-op so callers need not know how many endpoints exist. */
  if (_endpointCount() < 2) return false;

  /*- Read through getCurrentRPC first so an expired sticky window has
   *  already snapped us back to index 0.  Without this, a failover
   *  arriving after a long quiet period would advance from a stale
   *  index and skip endpoints. */
  getCurrentRPC();
  const from = _activeIdx;
  if (from >= _providers.length - 1) {
    /*- Already on the last endpoint: the list is exhausted.  Reporting
     *  this honestly is what lets callers stop retrying — with only two
     *  endpoints they could infer it from "the provider didn't change",
     *  but with three that inference is wrong. */
    log.warn(
      "[send-tx] RPC failover exhausted: no endpoint after %s",
      _urls[from],
    );
    return false;
  }

  _engageFailoverTo(from + 1, from);
  return true;
}

/**
 * Commit to endpoint `idx` and start the sticky window.
 *
 * Separate from `failoverToNextRPC` because the write path must be able
 * to PROVE an endpoint works before moving to it: `_estimateWithFailover`
 * probes candidates and commits only on success, so that a total outage
 * leaves the bot on its preferred endpoint rather than pinned to the
 * last one it happened to try.
 * @param {number} idx   Index to become active.
 * @param {number} from  Index we are leaving (for the log line).
 */
function _engageFailoverTo(idx, from) {
  _activeIdx = idx;
  _stickyUntilMs = Date.now() + FAILOVER_DURATION_MS;
  log.warn(
    "[send-tx] RPC failover engaged: %s → %s (sticky for %d min)",
    _urls[from],
    _urls[idx],
    Math.round(FAILOVER_DURATION_MS / 60_000),
  );
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
    /*- Walk forward through the remaining endpoints rather than taking
     *  a single hop.  This used to be one-way primary → fallback, which
     *  was the whole story when the list was a pair; with an ordered
     *  list, stopping after one hop would leave the last endpoint
     *  unreachable on the write path for no reason.
     *
     *  Candidates are PROBED, not committed to: the sticky window moves
     *  only once an endpoint has actually answered.  Committing first
     *  would mean a total outage ends with the bot pinned for an hour
     *  to whichever endpoint it happened to try last — strictly worse
     *  than staying on its preferred one and retrying there. */
    const startIdx = _activeIdx;
    for (let i = startIdx + 1; i < _providers.length; i++) {
      log.warn(
        "[send-tx] %s: estimateGas on %s failed — trying %s. Inner: %s",
        label,
        _urls[startIdx],
        _urls[i],
        curErr.shortMessage || curErr.message,
      );
      try {
        const gas = await _providers[i].estimateGas(populated);
        _engageFailoverTo(i, startIdx);
        return gas;
      } catch (nextErr) {
        log.warn(
          "[send-tx] %s: estimateGas on %s also failed. Inner: %s",
          label,
          _urls[i],
          nextErr.shortMessage || nextErr.message,
        );
      }
    }
    /*- Every endpoint refused, and nothing was committed — we are still
     *  on the endpoint we started from.  Throw the FIRST error: it came
     *  from the endpoint the caller was actually using, and is the one
     *  whose revert data (if any) describes the transaction. */
    throw curErr;
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
    log.info(
      "[send-tx] %s: estimate=%s × %sx → %s (floor %s)",
      label,
      String(estimate),
      String(mult),
      String(final),
      String(floor),
    );
    return final;
  } catch (err) {
    log.warn(
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
      log.info("[send-tx] %s: TX replaced, using replacement receipt", label);
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
  log.info(
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
    log.info(
      "[send-tx] %s: replacement TX submitted, hash=%s nonce=%d",
      label,
      replacement.hash,
      replacement.nonce,
    );
    return replacement;
  } catch (sendErr) {
    log.error(
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
  log.error(
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
  log.info(
    "[send-tx] %s: cancel TX submitted, hash=%s nonce=%d gasPrice=%s",
    label,
    cancelTx.hash,
    cancelTx.nonce,
    String(cancelGas),
  );
  const cancelReceipt = await cancelTx.wait();
  log.info(
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
  /*- No literal fallbacks per feedback_one_literal_per_shipped_default:
   *  config.TX_SPEEDUP_SEC and TX_CANCEL_SEC are sourced from
   *  app-runtime.json via parsePositiveInt; always positive numbers. */
  const speedupMs = config.TX_SPEEDUP_SEC * 1000;
  const cancelMs = config.TX_CANCEL_SEC * 1000;
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
  log.warn(
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
    log.error(
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
  log.info(
    "[send-tx] %s: TX submitted, hash=%s nonce=%d gasLimit=%s gasPrice=%s",
    label,
    tx.hash,
    tx.nonce,
    String(tx.gasLimit ?? "—"),
    String(tx.gasPrice ?? tx.maxFeePerGas ?? "—"),
  );

  const receipt = await _waitOrSpeedUp(tx, opts.signer, label);
  log.info(
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
  _providers = [];
  _urls = [];
  _activeIdx = 0;
  _stickyUntilMs = 0;
}

module.exports = {
  init,
  sendTransaction,
  getCurrentRPC,
  failoverToNextRPC,
  ensureReachable,
  getManagedReadProvider,
  /*- Internal helpers exposed for tests in test/send-transaction.test.js. */
  _resolveGasLimit,
  _estimateWithFailover,
  _waitOrSpeedUp,
  _isReadFailoverable,
  _resetForTests,
};
