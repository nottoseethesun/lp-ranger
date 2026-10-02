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
const { pauseForExhaustedEndpoints } = require("./rpc-endpoints-exhausted");
const rpcRequestManager = require("./rpc-request-manager");
const rpcOutOfService = require("./rpc-out-of-service");
const { noteRpcResult, decideIfCurrentRPCIsOutOfService, clearRpcSamples } =
  rpcOutOfService;

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
  /*- Connection-level refusals, which ethers passes through as the bare
   *  Node code rather than folding into one of its own.  Measured, not
   *  assumed: a closed port surfaces `ECONNREFUSED` and a name that
   *  does not resolve surfaces `ENOTFOUND`, both with no
   *  `responseStatus` at all.  Without these an endpoint that is wholly
   *  down is not failover-eligible — the read is read as the REQUEST
   *  being at fault and rethrown. */
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/*- 4xx answers that are the endpoint's fault rather than the request's.
 *  401 and 403 are credentials or a block (an expired key, a banned IP,
 *  a CDN refusing); 404 is the service moved or the path is wrong; 408
 *  is the endpoint giving up on its own read; 429 is a rate cap, which
 *  at least one configured endpoint publishes.
 *
 *  400 and 413 are deliberately absent.  Both describe the request —
 *  malformed, or an over-wide `getLogs` that `isBlockRangeCapError`
 *  already names with the setting to change — and failing over on them
 *  would walk the whole list hiding a bug instead of routing around an
 *  outage.  JSON-RPC errors such as -32602 arrive as HTTP 200 with an
 *  error body and never reach this test at all. */
const _READ_FAILOVER_STATUSES = new Set([401, 403, 404, 408, 429]);

function _isReadFailoverable(err) {
  if (!err) return false;
  if (err.code && _READ_FAILOVER_CODES.has(err.code)) return true;
  const status = err.info && err.info.responseStatus;
  if (!status) return false;
  const s = String(status);
  if (/^5\d\d/.test(s)) return true;
  return _READ_FAILOVER_STATUSES.has(Number.parseInt(s, 10));
}

/**
 * The URL an endpoint provider was built for.
 *
 * Reports name the endpoint they describe, and a provider is what a
 * caller holds, so the two are matched here by identity against the
 * registered list rather than by reading a URL off the provider —
 * ethers v6 exposes it only through `_getConnection()`, and a test
 * double has neither.
 *
 * @param {object} provider
 * @returns {string|null} The URL, or null for a provider not in the list.
 */
function _urlOf(provider) {
  const idx = _providers.indexOf(provider);
  return idx === -1 ? null : _urls[idx];
}

/**
 * Record an outcome for callers that hold a provider rather than a URL.
 *
 * The nonce wrapper broadcasts through whichever provider selection
 * named, and only this module can turn that object back into the
 * endpoint it belongs to.
 *
 * @param {object} provider  The provider the request went through.
 * @param {boolean} ok       Whether the endpoint answered.
 * @returns {void}
 */
function noteRpcOutcome(provider, ok) {
  noteRpcResult(_urlOf(provider), ok);
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
      noteRpcResult(_urls[i], true);
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
      noteRpcResult(_urls[i], false);
      const more = i < _providers.length - 1;
      log.warn(
        `[bot] RPC unreachable at startup (${i + 1} of ${_providers.length}): ${_urls[i]} — ${err.message}`,
      );
      if (more) log.info(`[bot] Falling back to ${_urls[i + 1]}`);
    }
  }
  /*- Every endpoint failed.  Say it plainly and in one line: what the
   *  caller logs is the raw ethers error plus a stack, which names a
   *  single endpoint and reads like a crash rather than like "this
   *  machine cannot reach the chain".
   *
   *  Startup is NOT the all-endpoints-down pause.  That pause belongs
   *  to `failoverToNextRPC`, which this probe does not use — it walks
   *  the list itself and commits only on success.  So nothing is held
   *  here, and the operator can restart the moment the connection is
   *  back rather than waiting an hour. */
  log.error(
    `[bot] STARTUP: no RPC endpoint answered — tried all ${_providers.length}, last was ${_urls[_providers.length - 1]}. The bot cannot start until one is reachable. Check this machine's internet connection, then the endpoint list in Bot Settings → Network.`,
  );
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
          return Promise.resolve(result).then(
            (value) => {
              noteRpcResult(_urlOf(current), true);
              return value;
            },
            (err) => {
              /*- Reported before the retry, and only when the endpoint
               *  is what failed: a malformed request says nothing about
               *  the endpoint's health and must not count against it. */
              if (_isReadFailoverable(err)) {
                noteRpcResult(_urlOf(current), false);
              }
              return retryRead({
                label: String(prop),
                /*- The read is one provider method here, so `run` just
                 *  re-applies it to whichever endpoint the loop hands
                 *  back.  A composite read uses the same seam to keep
                 *  all of its parts on one endpoint. */
                run: (provider) => provider[prop].apply(provider, args),
                err,
                isFailoverable: _isReadFailoverable,
                failover: failoverToNextRPC,
                current: getCurrentRPC,
                /*- Every attempt inside the retry loop is an outcome
                 *  too, and during an outage it is most of them.  Left
                 *  unreported, the rate would be judged on the single
                 *  sample above and never cross. */
                note: (provider, ok) => noteRpcResult(_urlOf(provider), ok),
                /*- So the recovery line can say which endpoint answered,
                 *  and whether it is the one that had been failing. */
                urlOf: _urlOf,
                /*- The provider this call was actually made against, so
                 *  the first failover report names it rather than
                 *  advancing from wherever selection has since drifted. */
                failedProvider: current,
              });
            },
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
   *  work to cancel and no way for the reset to be missed.
   *
   *  Announced, because engaging the failover is announced and a log
   *  that shows the leaving but not the returning leaves a reader to
   *  infer which endpoint is in service from whichever one next fails.
   *  Fires once per snapback — the assignment below is what makes the
   *  condition false again — so this cannot chatter on a hot path. */
  if (_activeIdx !== 0 && Date.now() >= _stickyUntilMs) {
    log.info(
      "[send-tx] RPC sticky window lapsed — back to %s (was on %s)",
      _urls[0],
      _urls[_activeIdx],
    );
    _activeIdx = 0;
  }
  return _providers[_activeIdx];
}

/**
 * URL of the currently selected endpoint, for the two callers that
 * build a provider per URL and need to know where to start.  Reads
 * through `getCurrentRPC` so an expired sticky window has snapped back
 * first.  `null` before `init` — those callers then use their own order.
 * @returns {string|null}
 */
function getCurrentRPCUrl() {
  if (_providers.length === 0) return null;
  getCurrentRPC();
  return _urls[_activeIdx];
}

/**
 * Report that an endpoint failed, and step one place forward through the
 * RPC list if it is still the one selected, sticky for
 * FAILOVER_DURATION_MS.
 *
 * Called by the read-retry loop when an endpoint answers with a failure
 * that is the endpoint's fault, and by the NonceManager wrapper when its
 * underlying RPC throws.
 *
 * **`failedProvider` is what keeps one endpoint from spending the whole
 * list.** Selection is process-wide, and the bot reads concurrently —
 * ten positions polling, a pool-state read, a chunked scan — so one
 * endpoint's failure arrives here several times within the same second.
 * Advancing on each arrival walks the index off the end of a
 * three-endpoint list in about that long, and stepping off the end
 * halts every JSON-RPC request in the process for an hour. The cost of
 * getting this wrong is therefore not a slow read: it is a frozen bot,
 * on endpoints that were never asked.
 *
 * Naming the endpoint makes the call idempotent. Ten failures against
 * the first endpoint advance once, because after the first advance
 * selection no longer sits where the others failed; the rest return
 * `false` and their callers retry on the endpoint the first one moved
 * to. The list is then spent only by endpoints that actually refused.
 *
 * Omitting the argument keeps the unconditional advance, which is a
 * different request — "step the list" rather than "this endpoint
 * failed" — and is what boot probes and tests driving state want. A
 * caller reacting to a failure always has the provider it called and
 * should pass it.
 *
 * The end of the list is not a dead end.  Stepping off the last endpoint
 * holds ALL RPC traffic for the configured wait, staying on the endpoint
 * it was on, and the list starts over at its first endpoint once that
 * wait is up — so later failovers walk it in the order they walked it at
 * startup.
 *
 * No-op on a single-endpoint chain (the PulseChain testnet ships one) —
 * there is nowhere to move and nothing a pause would achieve.
 *
 * @param {object} [failedProvider]  The provider the caller just saw
 *   fail. When given and selection has already moved off it, nothing
 *   happens. `null` counts as not given, so a caller whose provider
 *   turned out absent still steps rather than being silently pinned.
 * @returns {boolean} Whether selection actually moved.
 */
function failoverToNextRPC(failedProvider) {
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

  /*- Both absent forms mean "no endpoint named", so a caller holding a
   *  provider that turned out null gets the unconditional step rather
   *  than a guard that can never match — which would disable its
   *  failover silently, for the life of the process. */
  const named = failedProvider !== undefined && failedProvider !== null;

  /*- Someone else already moved us off the endpoint this caller saw
   *  fail, so its call is spent.  Checked after the snapback above,
   *  because that is what decides which endpoint `from` names. */
  if (named && _providers[from] !== failedProvider) return false;

  /*- A failure is a sample, not a verdict.  Selection moves only once
   *  this endpoint is failing more than the configured share of what it
   *  is asked, which is what lets every caller in the process report
   *  honestly — including the two that walk the endpoint list
   *  themselves and so fail several times per call. */
  if (!decideIfCurrentRPCIsOutOfService(_urls[from])) return false;

  if (from >= _providers.length - 1) {
    /*- Stay on the current endpoint for the duration — nothing can be
     *  sent anyway.  The pause's deadline becomes the sticky deadline,
     *  so the snapback `getCurrentRPC` already runs returns the list to
     *  its first endpoint once the wait is up: no second timer, and
     *  nothing else changes. */
    _stickyUntilMs = pauseForExhaustedEndpoints({
      endpointCount: _providers.length,
      lastUrl: _urls[from],
    });
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
  /*- Forget what the endpoint we are leaving did.  Coming back to it
   *  later should judge it on what it does then; carrying the window
   *  that retired it would retire it again on arrival, and relying on
   *  the window being shorter than the sticky period couples two
   *  settings an operator can change independently. */
  clearRpcSamples(_urls[from]);
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
    const gas = await cur.estimateGas(populated);
    noteRpcResult(_urlOf(cur), true);
    return gas;
  } catch (curErr) {
    /*- Only an endpoint fault is a sample.  An estimate that reverts is
     *  the contract answering through a working endpoint, and counting
     *  it would retire endpoints for the transaction being wrong. */
    if (_isReadFailoverable(curErr)) noteRpcResult(_urlOf(cur), false);
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
        noteRpcResult(_urls[i], true);
        _engageFailoverTo(i, startIdx);
        return gas;
      } catch (nextErr) {
        if (_isReadFailoverable(nextErr)) noteRpcResult(_urls[i], false);
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

/**
 * Pause between receipt polls, ending early if the phase is over.
 *
 * Ends on whichever comes first, the pause or the phase, so it always
 * settles. Not unref'd, for the same reason the phase timer is not: a
 * transaction is in flight and the rebalance lock is held, so the
 * process should see it through. `server.js` force-exits three seconds
 * after a shutdown signal regardless.
 *
 * @param {number} ms  How long to pause.
 * @param {AbortSignal} [signal]  Raised when the phase ends.
 * @returns {Promise<void>}
 */
function _waitOrAbort(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const handle = setTimeout(finish, ms);
    function finish() {
      clearTimeout(handle);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Get a transaction's receipt after its own provider stopped answering.
 *
 * Handed to `_waitOrSpeedUp`, which calls it when `tx.wait()` rejects.
 * `tx.wait()` polls the provider the transaction object was built with
 * and never asks which endpoint is current, so before this an endpoint
 * going down took the whole move with it — including moves whose
 * transaction had already been mined, which left funds moved and
 * nothing recorded.
 *
 * **A receipt is a read.** The transaction is already broadcast and
 * nothing is re-sent here; all that is needed is to ask a different
 * endpoint the same question. So it asks through the managed read
 * provider, which reports the outcome to the out-of-service decider and
 * fails over by itself. Nothing is added on top, because a second
 * failover mechanism would only race the first.
 *
 * Errors describing the TRANSACTION rather than the endpoint — a revert,
 * say — re-throw untouched. Those are answers, and another endpoint
 * would give the same one.
 *
 * **It polls rather than calling `waitForTransaction`**, and the
 * difference is the whole of this function's correctness.
 *
 * `waitForTransaction` subscribes: absent a receipt it re-subscribes to
 * the next block, forever. The speed-up path waits on two hashes and
 * only one can ever mine, so the loser would poll for the life of the
 * process. Handing it a deadline does not fix that here, because this
 * call goes through the managed read provider — and ethers rejects a
 * deadline with `code: "TIMEOUT"`, which that provider classes as an
 * endpoint failure and retries. The bound would be re-armed on the next
 * endpoint, forever, blaming a healthy one each time round.
 *
 * `getTransactionReceipt` has no such problem: it returns `null` when
 * the transaction is not mined and throws only when the endpoint is at
 * fault. "Not yet" and "broken" stop being the same signal, so the
 * managed provider can retry the second without touching the first, and
 * this loop owns the waiting. Nothing is subscribed, so when it stops,
 * it has stopped.
 *
 * The deadline comes from the caller, which owns the phase clock; the
 * config value is only the fallback for a caller that supplies none.
 * On expiry the ORIGINAL error is rethrown rather than a timeout,
 * because the endpoint failure is what actually went wrong.
 *
 * @param {Error} err    Why `tx.wait()` rejected.
 * @param {object} tx    The transaction being waited on.
 * @param {string} label Log label.
 * @param {number} [deadlineMs]  How long to keep asking.
 * @returns {Promise<object>} The receipt, from whichever endpoint serves it.
 */
async function _receiptAcrossEndpoints(err, tx, label, budget = {}) {
  if (!_isReadFailoverable(err)) throw err;
  log.warn(
    "[send-tx] %s: receipt wait failed (%s) — re-asking across endpoints for %s",
    label,
    err.message,
    tx.hash,
  );
  const provider = getManagedReadProvider();
  const until = Date.now() + (budget.deadlineMs ?? config.TX_CANCEL_SEC * 1000);
  for (;;) {
    /*- Checked before asking as well as after, so a phase that ended
     *  while the previous request was queued costs nothing more. */
    if (budget.signal?.aborted) throw err;
    const receipt = await provider.getTransactionReceipt(tx.hash);
    if (receipt) return receipt;
    if (budget.signal?.aborted || Date.now() >= until) throw err;
    /*- ethers' own block cadence, read off the provider rather than
     *  named here, so there is no second opinion about how often a
     *  chain produces a block. The global queue spaces requests but
     *  does not decide how often to ask for one. */
    await _waitOrAbort(provider.pollingInterval, budget.signal);
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

  const receipt = await _waitOrSpeedUp(
    tx,
    opts.signer,
    label,
    _receiptAcrossEndpoints,
  );
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
    though it is held in the queue: exhausting the list engages it.
    Left behind, one test that walks a short endpoint list to its end
    would hold every RPC request for the rest of the run. */
function _resetForTests() {
  _providers = [];
  _urls = [];
  _activeIdx = 0;
  _stickyUntilMs = 0;
  /*- Failure samples are this module's state too: left behind, one
   *  test's outage retires an endpoint for every test after it. */
  rpcOutOfService._resetForTests();
  rpcRequestManager._resetForTests();
}

module.exports = {
  init,
  setRpcUrls,
  sendTransaction,
  getCurrentRPC,
  getCurrentRPCUrl,
  noteRpcOutcome,
  failoverToNextRPC,
  ensureReachable,
  getManagedReadProvider,
  /*- Resolve one of this module's providers back to its url, so a
   *  caller that drives `retryRead` itself can name endpoints in its
   *  log lines the way the managed proxy does. */
  urlOf: _urlOf,
  /*- How many endpoints are actually in service.  A caller sizing an
   *  attempt budget needs this rather than `config.RPC_URLS.length`:
   *  the two are the same at boot but not afterwards, since
   *  `setRpcUrls` can re-point one without the other. */
  endpointCount: _endpointCount,
  /*- Internal helpers exposed for tests in test/send-transaction.test.js. */
  _resolveGasLimit,
  _estimateWithFailover,
  _isReadFailoverable,
  _resetForTests,
};
