/**
 * @file src/server-can-reopen.js
 * @description `POST /api/position/can-reopen` handler.  Reads on-chain
 *   wallet balances for both pair tokens, prices each via Moralis,
 *   compares each to the gold-pegged dust threshold, and reports
 *   whether the wallet has enough of at least one token to seed a
 *   re-open rebalance for a previously-drained position.
 *
 *   Extracted from `src/server-positions.js` to keep that file under
 *   the 500-line cap.  Wired into the route map via
 *   `createCanReopenHandler({ walletManager, jsonResponse,
 *   readJsonBody })`, mirroring the dependency-injection pattern of
 *   the other position-route handlers.
 */

"use strict";

const ethers = require("ethers");
const { log } = require("./log");
const { ERC20_ABI } = require("./rebalancer-pools");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { getDustThresholdUsd } = require("./dust");
const sendTx = require("./send-transaction");
const { noteRpcResult } = require("./rpc-out-of-service");
const { retryRead } = require("./rpc-read-retry");

/**
 * Error thrown when the wallet-balance + price reads for the
 * can-reopen check cannot be completed reliably after exhausting the
 * RPC retry budget.  Discriminator for the 503 response branch in
 * `handleCanReopen`; the dashboard maps the 503 body's
 * `error: "wallet-read-unavailable"` code to a dedicated modal that
 * tells the user to try again in 10+ minutes.
 */
class WalletReadUnavailableError extends Error {
  constructor(attempts, lastError) {
    super(
      `Wallet read failed after ${attempts} attempt(s): ` +
        (lastError?.message || String(lastError)),
    );
    this.name = "WalletReadUnavailableError";
    this.attempts = attempts;
    this.cause = lastError;
  }
}

/*- Inter-retry delay for the orchestrator below.  Mirrors the
 *  `getPoolState` configuration: 3 s is short enough to keep a Manage
 *  click feeling responsive (worst case ~10 s for 2-RPC × 2-attempt
 *  exhaustion) and long enough that a transient Moralis / RPC blip
 *  resolves before the retry.  `let` + a test-only setter so unit
 *  tests can drop the delay to zero. */
let _RETRY_DELAY_MS = 3000;
const _ATTEMPTS_PER_URL = 2;

/** Test-only helper: override the inter-retry delay (default 3 s). */
function _setRetryDelayForTests(ms) {
  _RETRY_DELAY_MS = ms;
}

/*- Read decimals + balanceOf + USD-price for a single ERC-20 token
 *  and compare to the dust threshold.  Pure read; the
 *  `new Contract(token, ERC20_ABI, provider)` pattern is the same one
 *  used by `bot-cycle-residual.js`, `compounder.js`, etc.
 *
 *  `balanceOf`, `decimals`, and `fetchTokenPriceUsd` all propagate
 *  errors — silently zeroing the price would risk a confidently-wrong
 *  "isDust: true" verdict, so any read failure must fail loud.  Only
 *  the cosmetic `symbol()` lookup keeps its fallback. */
async function readTokenBalance({
  provider,
  wallet,
  address,
  symbolHint,
  thresholdUsd,
}) {
  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  const [rawBal, decimalsRaw, priceUsd, onChainSymbol] = await Promise.all([
    contract.balanceOf(wallet),
    contract.decimals(),
    fetchTokenPriceUsd(address),
    symbolHint
      ? Promise.resolve(symbolHint)
      : contract.symbol().catch(() => "?"),
  ]);
  const decimals = Number(decimalsRaw);
  const amount = Number(rawBal) / 10 ** decimals;
  const usd = amount * (priceUsd || 0);
  return {
    symbol: onChainSymbol,
    decimals,
    raw: String(rawBal),
    amount,
    usd,
    isDust: usd <= thresholdUsd,
  };
}

/*- Read BOTH tokens' balances across the configured RPCs.  Partial
 *  failure (one token reads OK, the other throws) counts as a complete
 *  attempt failure per the user-approved policy — better a clean "try
 *  again" than a response mixing verified and unverified balances.
 *
 *  Endpoints come from the app's failover, not from a list this file
 *  walks: the shared loop in `src/rpc-read-retry.js` asks
 *  `sendTx.getCurrentRPC()` and reports failures to
 *  `sendTx.failoverToNextRPC()`, so this read follows selection and
 *  feeds the same rate as every other.  What it supplies is the pair of
 *  reads, a bounded budget, and the error raised when that budget is
 *  spent — a bound rather than an ordinary read's endless retry because
 *  someone is waiting on the dialog this answers.
 *
 *  Both balances come from ONE provider per attempt, which is why the
 *  retried unit is the pair and not each read: two balances fetched
 *  from different endpoints could straddle a block and disagree. */
async function _readBothBalancesWithRetry({
  body,
  wallet,
  thresholdUsd,
  readBalance,
}) {
  return retryRead({
    tag: "can-reopen",
    label: "wallet balances",
    run: (provider) =>
      Promise.all([
        readBalance({
          provider,
          wallet,
          address: body.token0,
          symbolHint: body.token0Symbol,
          thresholdUsd,
        }),
        readBalance({
          provider,
          wallet,
          address: body.token1,
          symbolHint: body.token1Symbol,
          thresholdUsd,
        }),
      ]).then(([t0, t1]) => ({ t0, t1 })),
    /*- The loop needs a failure to enter on and this caller has not
     *  attempted anything; only `isFailoverable` reads it. */
    err: new Error("wallet balances not read yet"),
    /*- Every failure here is treated as the endpoint's, which is what
     *  the hand-rolled walk did: a balance read that throws for any
     *  reason is worth asking another endpoint. */
    isFailoverable: () => true,
    failover: sendTx.failoverToNextRPC,
    current: sendTx.getCurrentRPC,
    urlOf: sendTx.urlOf,
    note: (provider, ok) => noteRpcResult(sendTx.urlOf(provider), ok),
    /*- Sized from the endpoints in service rather than
     *  `config.RPC_URLS.length`, which `setRpcUrls` can leave
     *  disagreeing.  Floored at one so an rpc layer nobody initialised
     *  throws that fault by name from `current()` instead of reporting
     *  a spent budget. */
    maxAttempts: Math.max(1, sendTx.endpointCount() * _ATTEMPTS_PER_URL),
    onExhausted: (attempts, lastErr) => {
      throw new WalletReadUnavailableError(attempts, lastErr);
    },
    delayMs: _RETRY_DELAY_MS,
  });
}

/**
 * Build the can-reopen handler bound to the given dependency set.
 * Returns a function that matches the existing `(req, res)` shape used
 * by the route map in `src/server-positions.js`.
 *
 * @param {object} deps
 * @param {object} deps.walletManager  Wallet manager instance.
 * @param {Function} deps.jsonResponse  `(res, status, body) => void`.
 * @param {Function} deps.readJsonBody  `(req) => Promise<object>`.
 * @param {Function} [deps.readBalance]  Optional override for the
 *   per-token balance reader (test-injection point).
 * @param {Function} [deps.getDust]  Optional override for the dust
 *   threshold getter (test-injection point).
 * @returns {(req, res) => Promise<void>}
 */
function createCanReopenHandler(deps) {
  const {
    walletManager,
    jsonResponse,
    readJsonBody,
    readBalance = readTokenBalance,
    getDust = getDustThresholdUsd,
  } = deps;
  return async function handleCanReopen(req, res) {
    const body = await readJsonBody(req);
    const wallet = walletManager.getAddress();
    if (!wallet) {
      jsonResponse(res, 400, { ok: false, error: "wallet not loaded" });
      return;
    }
    if (!body || !body.token0 || !body.token1) {
      jsonResponse(res, 400, {
        ok: false,
        error: "token0 and token1 are required",
      });
      return;
    }
    try {
      const { thresholdUsd } = await getDust();
      const { t0, t1 } = await _readBothBalancesWithRetry({
        body,
        wallet,
        thresholdUsd,
        readBalance,
      });
      const canReopen = !t0.isDust || !t1.isDust;
      jsonResponse(res, 200, {
        ok: true,
        canReopen,
        dustThresholdUsd: thresholdUsd,
        balances: { token0: t0, token1: t1 },
      });
    } catch (err) {
      log.error(
        "[pos-route] /api/position/can-reopen failed: %s\n%s",
        err.message,
        err.stack,
      );
      if (err instanceof WalletReadUnavailableError) {
        /*- Dedicated 503 + structured code so the dashboard renders
         *  the "couldn't read wallet right now, try again in 10+ min"
         *  modal instead of a generic alert.  Same shape as the
         *  `pool-info-unavailable` response. */
        jsonResponse(res, 503, {
          ok: false,
          error: "wallet-read-unavailable",
          message: err.message,
        });
        return;
      }
      jsonResponse(res, 500, {
        ok: false,
        error: "can-reopen check failed: " + err.message,
      });
    }
  };
}

module.exports = {
  createCanReopenHandler,
  readTokenBalance,
  WalletReadUnavailableError,
  _setRetryDelayForTests,
};
