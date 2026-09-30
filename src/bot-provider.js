/**
 * @file src/bot-provider.js
 * @module bot-provider
 * @description
 * RPC provider with automatic fallback and fee data patching.
 * Extracted from bot-loop.js.
 */

"use strict";
const { log } = require("./log");
const ethers = require("ethers");
const config = require("./config");
const rpcRequestManager = require("./rpc-request-manager");
const { readBotConfigDefaults } = require("./bot-config-defaults");

/*- Throttle for the per-call feeData log line.  Every call logs in
    --verbose mode; otherwise log at most once per hour so the terminal
    stays readable over long sessions. */
const _FEE_LOG_INTERVAL_MS = 60 * 60 * 1000;
let _lastFeeDataLogAt = 0;

/**
 * Patch `provider.getFeeData()` to guarantee a non-zero gas price.
 * PulseChain supports EIP-1559 but ethers.js v6's `getFeeData()` intermittently
 * returns null/0 for all fee fields.  When this happens, ethers submits TXs with
 * 0 gas price — they sit pending forever or get mined as failed.  This patch
 * intercepts the call and falls back to raw `eth_gasPrice` RPC when needed.
 * @param {import('ethers').JsonRpcProvider} provider
 */
function _patchFeeData(provider) {
  if (typeof provider.getFeeData !== "function") return;
  const _orig = provider.getFeeData.bind(provider);
  provider.getFeeData = async () => {
    const fd = await _orig();
    const now = Date.now();
    if (config.VERBOSE || now - _lastFeeDataLogAt >= _FEE_LOG_INTERVAL_MS) {
      _lastFeeDataLogAt = now;
      log.info(
        "[bot] feeData: gasPrice=%s maxFee=%s maxPriority=%s",
        String(fd.gasPrice),
        String(fd.maxFeePerGas),
        String(fd.maxPriorityFeePerGas),
      );
    }
    // Chain-specific gas price multiplier from app-config/app-defaults-for-user-configurable/chains.json.
    // Return ONLY gasPrice (no maxFeePerGas/maxPriorityFeePerGas) so
    // ethers.js sends legacy type 0 TXs. PulseChain validators don't
    // reliably include EIP-1559 type 2 TXs — they sit pending forever.
    const _mult = config.CHAIN.gasPriceMultiplier || 1;
    const gp = fd.gasPrice && fd.gasPrice > 0n ? fd.gasPrice : fd.maxFeePerGas;
    if (gp && gp > 0n) {
      const scaled = (gp * BigInt(Math.round(_mult * 1000))) / 1000n;
      return new ethers.FeeData(scaled, null, null);
    }
    log.warn(
      "[bot] getFeeData returned zero/null — falling back to eth_gasPrice RPC",
    );
    try {
      const gp = BigInt(await provider.send("eth_gasPrice", []));
      if (gp > 0n) {
        log.info("[bot] eth_gasPrice fallback: %s", String(gp));
        return new ethers.FeeData(gp, null, null);
      }
    } catch (e) {
      log.warn("[bot] eth_gasPrice fallback failed:", e.message);
    }
    return fd;
  };
}

/**
 * Route every JSON-RPC call this provider makes through the global
 * request manager.
 *
 * `send()` is the single funnel ethers puts all traffic through — reads,
 * writes, `eth_call`, `getBlockNumber`, transaction submission — so one
 * wrapper here paces the lot.  Patching at this level rather than at
 * each call site is what makes the guarantee hold: a new scan or a new
 * helper added later is paced automatically, with nothing to remember.
 *
 * Every provider shares the one queue, so pacing is a property of the
 * process, not of any single endpoint.
 * @param {import('ethers').JsonRpcProvider} provider
 */
/*- Per-endpoint 429 state, keyed by URL: `{ streak, penaltyUntilMs }`.
 *  Module state rather than per-request, because the penalty a refused
 *  request earns has to slow every LATER request to that endpoint: a
 *  schedule owned by one request restarts at its first delay for the
 *  next caller, so under a sustained refusal each one rediscovers the
 *  limit from scratch. */
const _rateLimited = new Map();

/** The record for one endpoint, created on first use. */
function _limitState(url) {
  let s = _rateLimited.get(url);
  if (!s) {
    s = { streak: 0, penaltyUntilMs: 0 };
    _rateLimited.set(url, s);
  }
  return s;
}

/*- Retry schedule override, for tests that must not wait ten seconds
 *  and must not patch `setTimeout` to avoid it.  Same shape as
 *  `_setDelays` in `src/price-source-backoff.js`; null means "use the
 *  configured schedule", which is every path but a test. */
let _delaysOverrideMs = null;

/*- Read once at load, as `rpc-request-manager.js` reads its pacing
 *  interval. `readBotConfigDefaults()` re-reads and merges the JSON
 *  from disk on every call — 46 microseconds — and `_delays` is
 *  consulted once per JSON-RPC request, which at ten thousand requests
 *  a second is most of a core spent on file I/O in the request path. */
const _CONFIGURED_DELAYS_MS = readBotConfigDefaults().rpcRetryOn429DelaysMs;
const _MAX_PENALTY_MS = readBotConfigDefaults().rpcMax429PenaltyMs;

/** The retry schedule now, in milliseconds. */
function _delays() {
  return _delaysOverrideMs === null ? _CONFIGURED_DELAYS_MS : _delaysOverrideMs;
}

/** Whether an error is the endpoint saying we are sending too fast. */
function _is429(err) {
  const status = err && err.info && err.info.responseStatus;
  return status !== undefined && status !== null && /^429/.test(String(status));
}

/** Wait `ms`, or return immediately when there is nothing to wait for. */
function _sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Lengthen this endpoint's standing penalty after a refusal.
 *
 * Doubling with the streak is what makes the process as a whole slow
 * down: a per-request schedule restarts at its first delay for every
 * caller, so under a sustained refusal each one rediscovers the limit
 * from scratch.
 *
 * @param {string} url    The endpoint that refused.
 * @param {number} baseMs The delay this request was about to wait anyway.
 */
function _note429(url, baseMs) {
  const s = _limitState(url);
  s.streak += 1;
  const escalated = Math.max(0, baseMs) * 2 ** (s.streak - 1);
  const until = Date.now() + Math.min(escalated, _MAX_PENALTY_MS);
  if (until > s.penaltyUntilMs) s.penaltyUntilMs = until;
}

/**
 * Send one request, waiting out this endpoint's rate limit rather than
 * moving off it.
 *
 * A 429 says this process is sending too fast; the endpoint is up and
 * answering. Moving would carry the same request rate to the next
 * endpoint and collect its refusal too, so the response is to wait.
 * The standing penalty is honoured before the request as well as after
 * it, so every caller to this endpoint slows down, not only the one
 * that was refused.
 *
 * @param {string} url   The endpoint this provider addresses.
 * @param {Function} send  The underlying `provider.send`.
 * @param {string} method
 * @param {unknown[]} params
 * @returns {Promise<*>}
 */
async function _sendWaitingOutRateLimits(url, send, method, params) {
  await _sleep(_limitState(url).penaltyUntilMs - Date.now());
  const delays = _delays();
  for (let i = 0; ; i++) {
    try {
      const out = await send(method, params);
      _rateLimited.delete(url);
      return out;
    } catch (err) {
      if (!_is429(err) || i >= delays.length) throw err;
      _note429(url, delays[i]);
      log.warn(
        "[rpc-429] %s refused %s — waiting %ds (retry %d/%d)",
        url,
        method,
        Math.round(delays[i] / 1000),
        i + 1,
        delays.length,
      );
      await _sleep(delays[i]);
    }
  }
}

function _patchRequestPacing(provider, url) {
  if (typeof provider.send !== "function") return;
  const _orig = provider.send.bind(provider);
  provider.send = async function (method, params) {
    await rpcRequestManager.acquire();
    return _sendWaitingOutRateLimits(url, _orig, method, params);
  };
}

/** Drop every endpoint's rate-limit state (tests only). */
function _reset429ForTests() {
  _rateLimited.clear();
  _delaysOverrideMs = null;
}

/** Override the retry schedule (tests only); null restores the config. */
function _setDelaysForTests(delaysMs) {
  _delaysOverrideMs = delaysMs;
}

/** This endpoint's standing penalty deadline in epoch ms, 0 when none. */
function _penaltyUntilMs(url) {
  return _limitState(url).penaltyUntilMs;
}

/**
 * Name the chain the app runs on, from configuration rather than by
 * asking an endpoint.
 *
 * ethers describes a chain with a `Network` object, and by default works
 * one out for itself: on the first read a provider issues `eth_chainId`
 * and adopts whatever answer comes back.  Sparing it that is the whole
 * purpose here.  `buildProvider` is the only caller, and it hands the
 * `Network` built below to every provider it constructs as the
 * `staticNetwork` option — which is ethers' way of being told the answer
 * in advance, so the provider reports that chain instead of asking.
 *
 * Two things follow, the first far weightier than the second.
 *
 * Detection is the one JSON-RPC call ethers can make without routing it
 * through `send()`; until a provider is `ready` it reaches past `send()`
 * to the `_send` primitive beneath.  That matters because `send()` is
 * where `src/rpc-request-manager.js` is wired in, and therefore where
 * the global pacing queue and the all-endpoints-down halt take hold.  A
 * provider that detects has a way to the wire around both of them; a
 * provider that never detects has none, which is what lets the queue's
 * promise be taken at face value — every JSON-RPC request the process
 * makes, with nothing outside it.
 *
 * The second is economy.  `getNetwork` detects afresh on every call so
 * it can check the answer against the first one it was given, so a read
 * cost two round trips where it now costs one.  Endpoints publish per-IP
 * limits, and reads are most of what the app spends them on.
 *
 * That repeated check is also what is given up: ethers will no longer
 * report an endpoint that changes chain mid-session.  It guarded little.
 * Each provider only ever compared an endpoint against its own earlier
 * answer, so two endpoints in the list disagreeing with each other went
 * unnoticed regardless, and a wrong chain announces itself immediately
 * as contract reads that find nothing where the pool should be.
 *
 * The id itself comes from `config.CHAIN`, chains.json being its sole
 * source of truth.  One ethers does not recognise is no obstacle:
 * `Network.from` then returns a network named "unknown" carrying that
 * id, which is all a provider needs of it.
 *
 * @param {object} lib  ethers module, or a test stub standing in for it.
 * @returns {object|null}  The chain's `Network`, or null when `lib` is a
 *   stub carrying no `Network` to build one from; `buildProvider` falls
 *   back to constructing the provider the plain way.
 * @throws {Error} When `config.CHAIN.chainId` is missing or is not a
 *   positive integer — rather than leave a provider to settle on a chain
 *   nobody chose.
 */
function _knownNetwork(lib) {
  if (typeof lib.Network?.from !== "function") return null;
  const chainId = config.CHAIN?.chainId;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(
      "[bot-provider] chainId missing/invalid for " +
        `${config.CHAIN?.displayName ?? "?"} — must be a positive integer in chains.json`,
    );
  }
  return lib.Network.from(chainId);
}

/**
 * Construct a single JsonRpcProvider for `url`, pace its requests, and
 * apply the feeData patch.
 *
 * Pure factory — does NOT perform a reachability check.  Used by callers
 * that need ALL configured providers built up-front (e.g. send-transaction.js
 * which holds the whole ordered RPC list for mid-session failover, and must
 * be able to reach for a later one even if the first was down at boot).
 * @param {string} url           RPC endpoint URL.
 * @param {object} [ethersLib]   Injected ethers library (for testing).
 * @returns {import('ethers').JsonRpcProvider}
 */
function buildProvider(url, ethersLib) {
  const lib = ethersLib || ethers;
  const network = _knownNetwork(lib);
  /*- The network goes in twice, as the provider's network AND as
   *  `staticNetwork`.  ethers asserts the two agree, then keeps the
   *  static one and hands it back from every later detection.
   *
   *  `cacheTimeout: -1` turns off ethers' own request cache, which
   *  otherwise holds each request's promise for 250 ms and hands the
   *  same one back to any identical request arriving inside that
   *  window.  **A rejected promise is cached like any other**, and the
   *  read-retry loop retries with identical arguments — so a failed
   *  read was answered from memory, instantly, as many times as the
   *  loop went round.  Two things followed, both bad.
   *
   *  The loop stopped being paced.  Pacing lives inside the patched
   *  `send()`, and a cached answer never reaches it; the loop then
   *  spun at memory speed, which is exactly what
   *  `src/rpc-read-retry.js` states cannot happen and why it carries no
   *  backoff of its own.
   *
   *  Worse, every turn of that loop reported another failure to
   *  `src/rpc-out-of-service.js`.  One refusal by one endpoint was
   *  counted hundreds of times, so what decides failover stopped being
   *  the endpoint's failure rate and became the loop's iteration count.
   *
   *  The cost of switching it off is that two identical reads issued
   *  within 250 ms now cost two requests.  That is the right trade:
   *  the global queue in `src/rpc-request-manager.js` is what bounds
   *  the request rate, and a cache that also silently bounded it was
   *  answering a question nobody asked it.
   *
   *  Only the branch that has a network.  The other one is reached when
   *  `Network.from` is absent — a stand-in ethers in a test — or when
   *  no chain declares a `chainId`, which neither shipped chain does.
   *  Nothing runs there in production, so nothing there needs the
   *  option. */
  const provider =
    network === null
      ? new lib.JsonRpcProvider(url)
      : new lib.JsonRpcProvider(url, network, {
          staticNetwork: network,
          cacheTimeout: -1,
        });
  _patchRequestPacing(provider, url);
  _patchFeeData(provider);
  return provider;
}

module.exports = {
  _patchFeeData,
  _patchRequestPacing,
  _penaltyUntilMs,
  _reset429ForTests,
  _setDelaysForTests,
  buildProvider,
};
