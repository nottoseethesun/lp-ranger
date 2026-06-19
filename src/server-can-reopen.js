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
const config = require("./config");
const { ERC20_ABI } = require("./rebalancer-pools");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { getDustThresholdUsd } = require("./dust");
const sendTx = require("./send-transaction");

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

/*- Read BOTH tokens' balances atomically across the configured RPCs.
 *  Partial failure (one token reads OK, the other throws) counts as
 *  a complete attempt failure per the user-approved policy — we'd
 *  rather present a clean "try again" to the user than mix
 *  verified + unverified balances in the response.
 *
 *  Iterates `[primary, fallback]`, each tried up to
 *  `_ATTEMPTS_PER_URL` times with a `_RETRY_DELAY_MS` wait before
 *  each retry.  Constructs fresh `JsonRpcProvider`s per URL (real
 *  ethers); falls back to the caller-supplied `providerFactory`
 *  return when ethersLib lacks the constructor (test-mock case).
 *
 *  Exhaustion throws `WalletReadUnavailableError` wrapping the most
 *  recent underlying error. */
async function _readBothBalancesWithRetry({
  body,
  wallet,
  thresholdUsd,
  readBalance,
  providerFactory,
}) {
  const urls = [config.RPC_URL, config.RPC_URL_FALLBACK].filter(Boolean);
  let attemptCount = 0;
  let lastErr = null;
  for (const url of urls) {
    for (let attempt = 1; attempt <= _ATTEMPTS_PER_URL; attempt++) {
      attemptCount++;
      if (attempt > 1) await new Promise((r) => setTimeout(r, _RETRY_DELAY_MS));
      try {
        let provider;
        try {
          provider = new ethers.JsonRpcProvider(url);
        } catch {
          provider = providerFactory();
        }
        const [t0, t1] = await Promise.all([
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
        ]);
        return { t0, t1 };
      } catch (err) {
        lastErr = err;
        log.warn(
          "[can-reopen] rpc=%s attempt=%d/%d failed: %s",
          url,
          attempt,
          _ATTEMPTS_PER_URL,
          err.message,
        );
      }
    }
  }
  throw new WalletReadUnavailableError(attemptCount, lastErr);
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
 * @param {Function} [deps.providerFactory]  Optional override that
 *   returns the read-provider; defaults to
 *   `sendTx.getManagedReadProvider`.  Tests inject a stub here.
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
    providerFactory = () => sendTx.getManagedReadProvider(),
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
        providerFactory,
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
         *  modal instead of a generic alert.  Mirrors the
         *  `pool-info-unavailable` pattern from PR #137. */
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
