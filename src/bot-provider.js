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
function _patchRequestPacing(provider) {
  if (typeof provider.send !== "function") return;
  const _orig = provider.send.bind(provider);
  provider.send = async function (method, params) {
    await rpcRequestManager.acquire();
    return _orig(method, params);
  };
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
   *  static one and hands it back from every later detection. */
  const provider =
    network === null
      ? new lib.JsonRpcProvider(url)
      : new lib.JsonRpcProvider(url, network, { staticNetwork: network });
  _patchRequestPacing(provider);
  _patchFeeData(provider);
  return provider;
}

module.exports = { _patchFeeData, _patchRequestPacing, buildProvider };
