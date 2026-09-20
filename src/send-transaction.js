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
 *   - failoverToNextRPC()     — step one place forward through the RPC
 *                               list for the next FAILOVER_DURATION_MS
 *                               (sticky window).  Off the end of the
 *                               list it pauses all RPC traffic and
 *                               restarts from the first endpoint.
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
const { _waitOrSpeedUp } = require("./tx-speedup");
const { retryRead } = require("./rpc-read-retry");
const {
  pauseForExhaustedEndpoints,
  endpointsArePaused,
} = require("./rpc-endpoints-exhausted");
const rpcRequestManager = require("./rpc-request-manager");

/**
 * How long a single failover stays sticky before we try the primary again.
 * One hour: long enough to ride out a sustained RPC outage, short enough
 * that a transient blip doesn't pin us to the (typically slower) fallback
 * for the rest of the bot's lifetime.  Module-internal — not exported.
 */
const FAILOVER_DURATION_MS = 60 * 60 * 1000;

/** Default gas-limit multiplier when chain config doesn't set one. */
const _DEFAULT_GAS_LIMIT_MULTIPLIER = 2;
/** Default gasLimit floor for callers that omit one. Sized so plain
 *  contract calls don't OOG on the worst tier we've observed. */
const _DEFAULT_FLOOR = 300_000n;

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
 * Re-point the RPC list at runtime, after the operator changes it.
 *
 * Separate from `init`, which deliberately refuses a second call with
 * different URLs — that guard exists so three boot paths cannot fight
 * over the endpoint list, and it should stay. This is the explicit,
 * operator-initiated exception.
 *
 * Safe to call mid-run: nothing holds a provider across a call.
 * `getManagedReadProvider` resolves through `getCurrentRPC()` on every
 * property access, and the nonce manager rebinds when the active
 * provider changes.
 *
 * Rebuilding resets the failover position to the top of the new list
 * and clears any sticky window, which is right: a window engaged
 * against the old list says nothing about the new one.
 *
 * @param {string[]} urls        Ordered RPC URLs, most-preferred first.
 * @param {object} [ethersLib]   Injected ethers library (for testing).
 * @returns {boolean}  True when the list changed and was rebuilt.
 */
function setRpcUrls(urls, ethersLib) {
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every(Boolean)) {
    throw new Error(
      "[send-tx] setRpcUrls: expected a non-empty ordered array of URL strings",
    );
  }
  if (_urls.length === urls.length && _urls.every((u, i) => u === urls[i])) {
    /*- No change.  Returning early keeps an unrelated config save from
     *  resetting a failover window that is doing its job. */
    return false;
  }
  const was = _urls.join(", ");
  _urls = [...urls];
  _providers = _urls.map((u) => buildProvider(u, ethersLib || ethers));
  _activeIdx = 0;
  _stickyUntilMs = 0;
  log.info("[send-tx] RPC list changed: %s → %s", was || "(none)", _urls[0]);
  return true;
}

/**
 * How many endpoints are actually available to move between.
 *
 * A chain configured with one endpoint (the testnet ships exactly that)
 * cannot fail over, and five call sites need that answer.  One accessor
 * rather than a `_primaryUrl === _fallbackUrl` test at each, which also
 * stops being correct once the list can hold more than two.
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
  /*- A TLS socket reset arrives as a bare Node system error rather than
   *  one of ethers' own codes, so it is listed explicitly.  Without it a
   *  reset mid-scan is read as the REQUEST being at fault and rethrown
   *  on the first occurrence, which ends the scan; observed doing
   *  exactly that after 3h26m of walking on 2026-09-15. A peer closing
   *  the connection says nothing about the request. */
  "ECONNRESET",
]);

/*- Rate limiting is the endpoint declining to serve *now*, not a
 *  malformed request, so it is failed over like any other endpoint
 *  fault.  Excluded by the 5xx test below because it is a 4xx, and at
 *  least one configured endpoint publishes a request-rate cap. Moving
 *  to another endpoint also spreads the load that produced it. */
const _RATE_LIMITED_STATUS = 429;

function _isReadFailoverable(err) {
  if (!err) return false;
  if (err.code && _READ_FAILOVER_CODES.has(err.code)) return true;
  const status = err.info && err.info.responseStatus;
  if (!status) return false;
  const s = String(status);
  if (/^5\d\d/.test(s)) return true;
  return s.startsWith(String(_RATE_LIMITED_STATUS));
}

/**
 * Boot-time reachability probe for the primary RPC.  Calls
 * `primary.getBlockNumber()`; if it throws, engages `failoverToNextRPC()`
 * and verifies that `fallback.getBlockNumber()` succeeds.  The result
 * is reported through the shared `getCurrentRPC` state, so subsequent
 * reads (via `getManagedReadProvider`) and writes go to the same RPC as
 * the probe settled on.
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
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        /*- ethers resolves a Contract's provider through
         *  `runner.provider` (`getProvider` in ethers' contract.js), and
         *  an ethers provider's own `.provider` is a getter returning
         *  itself.  That is not a function, so the branch below would
         *  hand back the RAW provider and every `queryFilter` in the app
         *  — event scanner, scanNftEvents, HODL, pool-creation finder —
         *  would call `getLogs` outside this wrapper, with no retry and
         *  no failover.  One transient 502 then drops a whole block
         *  window.  Returning the proxy keeps the wrapper across the
         *  hop. */
        if (prop === "provider") return proxy;
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
          return Promise.resolve(result).catch((err) =>
            retryRead({
              prop,
              args,
              err,
              isFailoverable: _isReadFailoverable,
              failover: failoverToNextRPC,
              current: getCurrentRPC,
            }),
          );
        };
      },
    },
  );
  return proxy;
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
 * Step one place forward through the RPC list, sticky for
 * FAILOVER_DURATION_MS.
 *
 * Called by the read-retry loop when an endpoint answers with a failure
 * that is the endpoint's fault, and by the NonceManager wrapper when its
 * underlying RPC throws.
 *
 * The end of the list is not a dead end.  Stepping off the last endpoint
 * pauses ALL RPC traffic for the configured outage pause and puts
 * selection back on the first endpoint, so the list is walked again in
 * its original order when the pause lifts.  Further calls during that
 * pause move nothing: they report the same outage.
 *
 * No-op on a single-endpoint chain (the PulseChain testnet ships one) —
 * there is nowhere to move and nothing a pause would achieve.
 *
 * @returns {boolean} Whether selection actually moved.
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

  /*- An all-endpoints-down pause is already running.  It was started by
   *  a walk that had just tried every endpoint, and it put selection
   *  back on the first one; this report describes that same outage.
   *  Moving on it would walk the list forward again while nothing can
   *  be sent anyway, so the pause would lift with selection stranded
   *  mid-list.  Two positions failing in the same minute is all it
   *  takes.  Reported as "did not move", which is the truth. */
  if (endpointsArePaused()) return false;

  /*- Read through getCurrentRPC first so an expired sticky window has
   *  already snapped us back to index 0.  Without this, a failover
   *  arriving after a long quiet period would advance from a stale
   *  index and skip endpoints. */
  getCurrentRPC();
  const from = _activeIdx;
  if (from >= _providers.length - 1) {
    pauseForExhaustedEndpoints({
      endpointCount: _providers.length,
      lastUrl: _urls[from],
    });
    /*- Back to the top of the list NOW, not when the pause lifts.
     *  Every request is held for the duration anyway, so the endpoint
     *  selected here is simply the one the first request after the
     *  pause will use — and that must be the preferred endpoint, so
     *  the list is walked in its original order.
     *
     *  Deferring the wrap to the snapback in `getCurrentRPC` looks
     *  equivalent and is not.  `retryRead` advances BEFORE each
     *  attempt, so it would spend its first post-pause call on the
     *  endpoint that just failed and then step from there to the
     *  second — skipping the preferred endpoint on every lap.
     *
     *  The index alone, without also expiring `_stickyUntilMs`: at index
     *  0 that deadline is never read — `getCurrentRPC` short-circuits on
     *  `_activeIdx !== 0` — and every path that leaves index 0 writes a
     *  fresh one. Clearing it too would be a second way to say the same
     *  thing, and only one of the two could ever be the one that works. */
    _activeIdx = 0;
    return true;
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
     *  a single hop: with three or more configured, stopping after one
     *  hop leaves every endpoint past the second unreachable on the
     *  write path.
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
    re-init with different rpcConfig shapes without leaking module state.

    The all-endpoints-down pause counts as this module's state even
    though it is held in the queue: exhausting the list engages it, and
    `failoverToNextRPC` refuses to move while it runs.  Left behind, one
    test that walks a short endpoint list to its end would silently
    freeze failover for every test after it in the same file. */
function _resetForTests() {
  _providers = [];
  _urls = [];
  _activeIdx = 0;
  _stickyUntilMs = 0;
  rpcRequestManager._resetForTests();
}

module.exports = {
  init,
  setRpcUrls,
  sendTransaction,
  getCurrentRPC,
  failoverToNextRPC,
  ensureReachable,
  getManagedReadProvider,
  /*- Internal helpers exposed for tests in test/send-transaction.test.js. */
  _resolveGasLimit,
  _estimateWithFailover,
  _isReadFailoverable,
  _resetForTests,
};
