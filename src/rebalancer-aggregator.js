/**
 * @file rebalancer-aggregator.js
 * @description 9mm DEX Aggregator swap path for the rebalancer.
 *   Fetches quotes from the aggregator API, submits TXs with
 *   cancel-and-requote retry on timeout. Used as the primary
 *   swap path; V3 router in rebalancer-swap.js is the fallback.
 *
 *   Chain-specific tunables (cancel gas multiplier, wait timeout,
 *   max attempts) are loaded from app-config/app-defaults-for-user-configurable/chains.json via config.CHAIN.
 */

"use strict";

const config = require("./config");
const { log } = require("./log");
const { loadShippedDefaults } = require("./load-merged-defaults");

/*- Shipped default for slippagePct.  Per
 *  feedback_one_literal_per_shipped_default, the literal lives only in
 *  bot-config-defaults.json. */
const _DEFAULTS = loadShippedDefaults("bot-config-defaults.json");
const {
  ERC20_ABI,
  _checkSwapImpact,
  _ensureAllowance,
  _retrySend,
} = require("./rebalancer-pools");

/** Chain-specific aggregator tunables from app-config/app-defaults-for-user-configurable/chains.json. */
const { settleNonce } = require("./aggregator-nonce-settle");
const { receiptGasWei } = require("./receipt-gas");
/*- The classifier the retry layer uses, from the module that owns it: a
 *  failed send is safe to fall back from only when the node never admitted
 *  the transaction, and that bucket is its answer, not ours to restate. */
const { classifyRpcError } = require("./rpc-error-classifier");
/*- For the receipt wait only. This module broadcasts its own swap and
 *  runs its own cancel-and-requote recovery, but reading a receipt means
 *  asking an endpoint, and which endpoint to ask is owned there. */
const sendTx = require("./send-transaction");

const _agg = config.CHAIN.aggregator;

/*- `_agg.waitMs` is 180 s and `config.CHAIN` is frozen, so a test covering
 *  the timeout path would otherwise have to wait it out twice — once for the
 *  swap and again for the cancel.  Same shape as `_setRetryDelayForTests` in
 *  rebalancer-pools: a `let` the test lowers, leaving the orchestration it is
 *  exercising untouched. */
let _waitMsForTests = null;

/** Test-only helper: override the confirmation budget (default 180 s). */
function _setWaitMsForTests(ms) {
  _waitMsForTests = ms;
}

/**
 * Base URL for the aggregator REST API on the active chain, including
 * the chain slug path segment: `https://api.9mm.pro/pulsechain`.
 *
 * The slug is NOT optional and is NOT the same thing as the canonical
 * chain id, even though PulseChain's happen to match — it is the
 * vendor's own path segment, so it lives in each chain's
 * `aggregator.blockchain` in chains.json alongside the other
 * per-vendor slugs (`chartProviders`, `dexPairDetailPageUrl`).
 *
 * Throws when no slug is configured. That is deliberate: omitting the
 * segment yields `https://api.9mm.pro/swap/v1/quote`, which the API
 * answers with a **404**. Because a failed aggregator quote falls
 * through to the V3 SwapRouter, that 404 is invisible — swaps still
 * complete, just on the worse route — so it went unnoticed from the
 * moment the aggregator shipped. Throwing keeps the same fallback
 * behaviour but puts the reason in the log instead of hiding it.
 *
 * @returns {string} Base URL with no trailing slash.
 * @throws {Error} When the active chain configures no aggregator slug.
 */
function _aggregatorBase() {
  const slug = _agg?.blockchain;
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error(
      `No aggregator chain slug configured for ${config.CHAIN_NAME} ` +
        `(chains.json → ${config.CHAIN_NAME}.aggregator.blockchain). ` +
        "Omitting it makes the API return 404; falling back to the V3 router.",
    );
  }
  return `${config.AGGREGATOR_URL}/${slug}`;
}

/**
 * Display label for the 9mm DEX Aggregator route.  Single source of
 * truth used by:
 *   - this module (stamped onto result.swapSources on every successful
 *     aggregator swap)
 *   - the Mission Control "Routing through:" badge default
 *     (see AGGREGATOR_LABEL in public/dashboard-routing-labels.js — the
 *     client-side constant that MUST stay in sync with this value)
 *   - the hard-coded fallback in public/index.html (pre-render default
 *     before the first /api/status poll paints the badge)
 *
 * Intentionally coarse: we do NOT drill into the underlying pools
 * (NineMM_V3, PulseX_V2, …) that the aggregator chose, because the
 * aggregator owns its routing decisions and exposing them misleads
 * users into thinking a direct pool swap was used.
 */
const AGGREGATOR_LABEL = "9mm Aggregator";

/**
 * Fetch a quote from the 9mm DEX Aggregator.
 * @param {string} sellToken  Sell token address.
 * @param {string} buyToken   Buy token address.
 * @param {bigint} sellAmount Amount in base units.
 * @param {number} slippagePct Slippage as a percentage (e.g. 0.5).
 * @returns {Promise<object>} Quote response.
 */
async function _fetchQuote(sellToken, buyToken, sellAmount, slippagePct) {
  const slip = (slippagePct ?? _DEFAULTS.slippagePct) / 100;
  // No takerAddress — the 9mm web UI omits it, and including it
  // causes the API to generate different calldata that reverts on-chain.
  const url =
    _aggregatorBase() +
    "/swap/v1/quote" +
    "?sellToken=" +
    sellToken +
    "&buyToken=" +
    buyToken +
    "&sellAmount=" +
    String(sellAmount) +
    "&slippagePercentage=" +
    slip +
    "&includedSources=";
  log.info("[aggregator] GET %s", url);
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "0x-api-key": config.AGGREGATOR_API_KEY || "",
    },
  });
  if (!res.ok) {
    let body = "";
    try {
      const json = await res.json();
      const reason = json.reason || json.code || "";
      const valErrs = (json.validationErrors || [])
        .map((e) => `${e.field}: ${e.reason}`)
        .join("; ");
      const balIssue = json.issues?.balance
        ? `balance: actual=${json.issues.balance.actual}` +
          ` expected=${json.issues.balance.expected}`
        : "";
      const allowIssue = json.issues?.allowance
        ? `allowance: actual=${json.issues.allowance.actual}` +
          ` spender=${json.issues.allowance.spender}`
        : "";
      body = [reason, valErrs, balIssue, allowIssue]
        .filter(Boolean)
        .join(" | ");
    } catch {
      /* response wasn't JSON */
    }
    throw new Error(
      "Aggregator API: HTTP " + res.status + (body ? " — " + body : ""),
    );
  }
  const json = await res.json();
  if (config.VERBOSE) {
    log.info("[aggregator] Response: %s", JSON.stringify(json));
  } else {
    const brief = {
      ...json,
      data: '"Elided B.l.o.b. - run in --verbose mode to see"',
    };
    if (brief.orders)
      brief.orders = brief.orders.map((o) => {
        const b = { ...o };
        if (b.fillData) b.fillData = { ...b.fillData };
        if (b.fillData?.uniswapPath)
          b.fillData.uniswapPath =
            '"Elided B.l.o.b. - run in --verbose mode to see"';
        return b;
      });
    log.info("[aggregator] Response: %s", JSON.stringify(brief));
  }
  return json;
}

/** Get gasPrice from provider fee data. */
async function _getGasPrice(provider) {
  const fd = await provider.getFeeData();
  return fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
}

/** Compute buffered gas limit from quote using chain config multiplier.
 *  Per feedback_one_literal_per_shipped_default: gasLimitMultiplier
 *  lives in chains.json; throw loudly if a chain forgot to set it.
 *  The `300000` floor is when the aggregator quote omits gas entirely
 *  (extremely rare) — a defensive emergency value, not a shipped Bot
 *  Setting. */
function _gasLimit(quote) {
  const mult = config.CHAIN.gasLimitMultiplier;
  if (typeof mult !== "number" || mult <= 0) {
    throw new Error(
      "[aggregator] chains.json gasLimitMultiplier missing/invalid for " +
        `${config.CHAIN?.displayName ?? "?"} — must be a positive number`,
    );
  }
  const raw = Number(quote.gas || quote.estimatedGas || 300000);
  return BigInt(Math.ceil(raw * mult));
}

/**
 * Unwrap a NonceManager to get the base signer for cancel TXs.
 * @param {import('ethers').Signer} signer
 * @returns {import('ethers').Signer}
 */
function _baseSigner(signer) {
  return signer.signer ?? signer;
}

/**
 * Cancel a pending nonce with a 0-value self-transfer at higher gas, and
 * report what became of it.
 *
 * Gas is `max(feeData × cancelMultiplier, sentGasPrice × 1.5)` so the cancel
 * always outbids the transaction it is replacing — the same pattern as
 * `_waitOrSpeedUp`. The send reuses the stuck nonce, which is why it goes
 * through `_baseSigner` to bypass the NonceManager, and why
 * `retryingTxWithSameNonce` tells `_retrySend` that a "nonce too low" refusal
 * means the original mined rather than that the send needs recovery.
 *
 * It returns the hash and the receipt-or-null rather than a gas figure,
 * because the caller's next move turns on whether this nonce is now spent and
 * a number cannot carry that: zero wei is both a plausible cost and the value
 * an unconfirmed cancel would report. The wait is bounded by `waitMs` and a
 * rejected wait resolves to null, so a null receipt means only "no receipt
 * yet", never "cancelled". `settleNonce` turns that into an answer.
 *
 * @param {import('ethers').Signer} signer Signer, possibly a NonceManager.
 * @param {object} provider  Provider used for the fee-data read.
 * @param {number} nonce     The stuck nonce to occupy.
 * @param {number} waitMs    How long to wait for the cancel's receipt.
 * @param {bigint} sentGasPrice Gas price the pending TX was sent at.
 * @returns {Promise<{hash: string, receipt: object|null}>}
 */
async function _cancelNonce(signer, provider, nonce, waitMs, sentGasPrice) {
  const gp = await _getGasPrice(provider);
  const fromFee = BigInt(Math.ceil(Number(gp) * _agg.cancelGasMultiplier));
  const floor = ((sentGasPrice || 0n) * 3n) / 2n;
  const cancelGp = fromFee > floor ? fromFee : floor;
  // Bypass NonceManager — cancel TX must reuse the stuck nonce.
  const base = _baseSigner(signer);
  const addr = await base.getAddress();
  log.info(
    "[aggregator] cancel nonce=%d: gasPrice=%s gasLimit=21000 (type 0)",
    nonce,
    String(cancelGp),
  );
  // Same-nonce send: if the chain has already mined the original TX
  // we'll get "nonce too low" — that means our cancel target already
  // confirmed and there's nothing to cancel.  Skip recovery.
  const c = await _retrySend(
    () =>
      base.sendTransaction({
        to: addr,
        value: 0,
        nonce,
        gasPrice: cancelGp,
        gasLimit: 21000,
        type: config.TX_TYPE,
      }),
    "[aggregator] cancel nonce=" + nonce,
    { signer: base, retryingTxWithSameNonce: true },
  );
  log.info(
    "[aggregator] cancel: TX submitted, hash= %s nonce=%d gasPrice=%s",
    c.hash,
    c.nonce,
    String(c.gasPrice ?? "—"),
  );
  const receipt = await Promise.race([
    c.wait().catch(() => null),
    new Promise((r) => setTimeout(r, waitMs)).then(() => null),
  ]);
  return { hash: c.hash, receipt };
}

/**
 * Handle a retryable aggregator error (timeout or on-chain revert) and report
 * whether the nonce it used is settled.
 *
 * The two failure modes differ in what they leave behind. An on-chain revert
 * consumed the nonce itself, so nothing is pending and the slot is spent. A
 * timeout leaves the swap in the mempool, and the only way to free the slot is
 * a cancel at the same nonce. Every way that cancel can fail leaves the nonce
 * unexamined, and none of them may escape as an error: refused as "nonce too
 * low" because the swap mined, answered "already known" because the cancel
 * itself is pending, or never broadcast at all because the txpool is full or
 * the retries ran out. An error leaving here is unflagged, and the caller's
 * router fallback reads unflagged as "no swap happened" and sends a second
 * one — so all of them hand the question to `settleNonce` and the chain.
 *
 * The caller needs three distinguishable answers and so gets an object rather
 * than a gas total: `swapReceipt` when the swap itself landed and must be
 * reported as the swap, `nonceSpent` when the slot is settled and a re-quote
 * at the next nonce is safe, and neither when the slot is still open — the
 * state in which a retry would risk a second swap of the same balance.
 * `cancelGasWei` is carried alongside because the cancel's gas is spent either
 * way and belongs in the move's cost.
 *
 * @param {Error}  err      The error that ended the swap's wait.
 * @param {import('ethers').Signer} signer Signer, possibly a NonceManager.
 * @param {object} provider Read provider.
 * @param {object} tx       The submitted swap, for its `hash` and `nonce`.
 * @param {number} waitMs   Confirmation budget, reused for the cancel.
 * @param {string} fromSym  Sell-token symbol, for logs.
 * @param {string} toSym    Buy-token symbol, for logs.
 * @param {bigint} sentGasPrice Gas price the swap was sent at.
 * @returns {Promise<{cancelGasWei: bigint, swapReceipt: object|null,
 *   nonceSpent: boolean}>}
 */
async function _handleSwapError(
  err,
  signer,
  provider,
  tx,
  waitMs,
  fromSym,
  toSym,
  sentGasPrice,
) {
  if (err.message !== "_AGG_TIMEOUT") {
    log.warn(
      "[rebalance] swap (aggregator): %s -> %s reverted" +
        " on-chain (gasUsed=%s) — re-quoting",
      fromSym,
      toSym,
      String(err.receipt?.gasUsed ?? "?"),
    );
    return { cancelGasWei: 0n, swapReceipt: null, nonceSpent: true };
  }
  log.warn(
    "[rebalance] swap (aggregator): %s -> %s not confirmed" +
      " in %ds — cancelling nonce %d (%sx gas)",
    fromSym,
    toSym,
    waitMs / 1000,
    tx.nonce,
    String(_agg.cancelGasMultiplier),
  );
  let cancel = { hash: null, receipt: null };
  try {
    cancel = await _cancelNonce(
      signer,
      provider,
      tx.nonce,
      waitMs,
      sentGasPrice,
    );
  } catch (cancelErr) {
    /*- No cancel failure may rethrow from here.  An error leaving this
     *  function carries no `nonceUnsettled`, and the caller's router
     *  fallback reads an unflagged error as "no swap happened" and sends a
     *  second swap of the same balance — the defect this whole path
     *  exists to prevent, reached through the cancel instead of the swap.
     *
     *  Every way the cancel can fail is the same fact: this nonce is
     *  unexamined.  "Nonce too low" is the chain reporting the swap mined.
     *  "Already known" is the cancel itself sitting in the mempool, since
     *  `_retrySend` resubmits a byte-identical request. A full txpool, a
     *  refused gas price, or three exhausted retries mean no cancel is
     *  pending at all.  None of them says what became of the swap, so all
     *  of them hand the question to `settleNonce` and the chain. */
    log.warn(
      "[rebalance] swap (aggregator): cancel at nonce %d did not confirm" +
        " (%s) — settling from chain state",
      tx.nonce,
      cancelErr.message,
    );
  }
  // Re-sync NonceManager after cancel so its counter matches chain state.
  if (typeof signer.reset === "function") signer.reset();
  const settled = await settleNonce(provider, tx.hash, cancel);
  log.info(
    "[rebalance] swap (aggregator): nonce %d — swap mined=%s, slot spent=%s",
    tx.nonce,
    settled.swapReceipt ? "yes" : "no",
    settled.nonceSpent ? "yes" : "no",
  );
  return {
    cancelGasWei: cancel.receipt ? receiptGasWei(cancel.receipt) : 0n,
    swapReceipt: settled.swapReceipt,
    nonceSpent: settled.nonceSpent,
  };
}

/**
 * Broadcast the swap, marking a failure the caller must not fall back from.
 *
 * A send that failed is not the same as a send that did not happen, and the
 * difference decides whether `swapIfNeeded`'s V3-router fallback is a recovery
 * or a second swap of this balance. The classifier's own buckets answer it,
 * which is why the question is asked of `classifyRpcError` rather than
 * restated here: `terminal-nonce-unused` is the node rejecting the transaction
 * "before it was admitted to the executable pending pool", so nothing is live
 * and falling back is correct. A `transient` failure says the transaction "may
 * or may not have been broadcast", and `_retrySend` resets the nonce and tries
 * again, so one that did land can be joined by a second at another nonce; a
 * consumed nonce says something is on chain already.
 *
 * Those two cannot be settled the way a timeout can — the send threw, so there
 * is no hash to ask the chain about — so they are stamped `nonceUnsettled` and
 * the rebalance fails rather than risking the swap twice.
 *
 * @param {import('ethers').Signer} signer Nonce-managed signer.
 * @param {object} txReq   Populated transaction request, without a nonce.
 * @param {string} label   Log label for the retry layer.
 * @returns {Promise<object>} The submitted transaction.
 */
async function _sendSwap(signer, txReq, label) {
  try {
    return await _retrySend(() => signer.sendTransaction(txReq), label, {
      signer,
    });
  } catch (sendErr) {
    if (classifyRpcError(sendErr) === "terminal-nonce-unused") throw sendErr;
    sendErr.nonceUnsettled = true;
    throw sendErr;
  }
}

/**
 * Price an aggregator submission.
 *
 * The quote carries the gas price the aggregator assumed, and the chain has
 * whatever it has now; taking the higher of the two keeps a quote priced
 * during a lull from being submitted under the current market. The chain's
 * `gasPriceMultiplier` is then applied so the submission sits above the going
 * rate rather than at it. A quote without a gas price and a chain without a
 * multiplier both fall back to a figure that leaves the other term unchanged.
 *
 * @param {object} provider Provider for the fee-data read.
 * @param {object} quote    Aggregator quote, possibly carrying `gasPrice`.
 * @returns {Promise<bigint>} The gas price to submit at.
 */
async function _submitGasPrice(provider, quote) {
  const gp = await _getGasPrice(provider);
  const qgp = BigInt(quote.gasPrice || 0);
  const base = qgp > gp ? qgp : gp;
  const m = _agg.gasPriceMultiplier || 1;
  return (base * BigInt(Math.round(m * 1000))) / 1000n;
}

/**
 * Turn a handled swap failure into the retry loop's next move.
 *
 * Three answers come back from `_handleSwapError` and each has exactly one
 * safe continuation. A `swapReceipt` means the swap mined after its wait
 * expired, so it is returned as the swap's result — which is what keeps the
 * caller's router fallback from swapping the same balance a second time, since
 * that fallback treats any throw from here as "no swap happened". A spent
 * nonce means the slot is closed to the swap and a fresh quote at the next
 * nonce is safe, so this returns null and the loop continues. An unspent nonce
 * means the swap is still able to mine, and every continuation — retrying at
 * the next nonce, or falling through to the router — spends the balance twice
 * if it does, so it throws with `nonceUnsettled` set for the fallback to
 * recognise and decline.
 *
 * @param {object} a            Arguments.
 * @param {object} a.outcome    What `_handleSwapError` reported.
 * @param {object} a.tx         The submitted swap, for its `hash` and `nonce`.
 * @param {number} a.waitMs     Confirmation budget, for the message.
 * @param {bigint} a.cancelGasTotal Cancel gas accumulated across attempts.
 * @param {string} a.ctx        Log context.
 * @param {string} a.fromSym    Sell-token symbol.
 * @param {string} a.toSym      Buy-token symbol.
 * @returns {object|null} The swap's result when it landed, else null.
 */
function _resolveSwapOutcome({
  outcome,
  tx,
  waitMs,
  cancelGasTotal,
  ctx,
  fromSym,
  toSym,
}) {
  if (outcome.swapReceipt) {
    log.info(
      "[rebalance] %s: swap (aggregator) confirmed late %s -> %s" +
        " gasUsed=%s — accepting it instead of retrying",
      ctx,
      fromSym,
      toSym,
      String(outcome.swapReceipt.gasUsed),
    );
    return {
      txHash: outcome.swapReceipt.hash,
      gasCostWei: receiptGasWei(outcome.swapReceipt) + cancelGasTotal,
    };
  }
  if (outcome.nonceSpent) return null;
  const unsettled = new Error(
    "Aggregator swap nonce " +
      tx.nonce +
      " unsettled: neither the swap (" +
      tx.hash +
      ") nor its cancel confirmed within " +
      waitMs / 1000 +
      "s. Not retrying — the swap may still mine.",
  );
  unsettled.nonceUnsettled = true;
  /*- The cancel was broadcast and its gas is spent whatever happens next.
   *  `executeRebalance`'s catch reads this field off the error already, the
   *  same seam `tx-speedup.js` uses, so carrying it here is what keeps the
   *  charge out of the gap between a thrown frame and the recorder. */
  unsettled.cancelGasCostWei = cancelGasTotal;
  throw unsettled;
}

/**
 * Submit aggregator TX with retry on both timeout and on-chain revert.
 *
 * Two failure modes, same recovery (fresh quote + retry):
 *  - Timeout: TX not mined in waitMs → cancel nonce, then re-quote.
 *  - On-chain revert (CALL_EXCEPTION, status=0): route's encoded pool
 *    states went stale between quote and execution. Nonce is already
 *    consumed — just re-quote and submit at the next nonce.
 *
 * Chain-specific tunables (waitMs, cancelGasMultiplier, maxAttempts)
 * come from app-config/app-defaults-for-user-configurable/chains.json.
 */
async function _sendWithRetry(
  signer,
  provider,
  quote,
  slippagePct,
  tokenIn,
  tokenOut,
  amountIn,
  symIn,
  symOut,
  cx,
) {
  const waitMs = _waitMsForTests ?? _agg.waitMs;
  const maxAttempts = _agg.maxAttempts;
  const fromSym = symIn || tokenIn.slice(0, 10);
  const toSym = symOut || tokenOut.slice(0, 10);
  /*- Fallback to a synthetic prefix when the caller didn't thread the
   *  6-field context — keeps tests and ad-hoc callers readable. */
  const ctx = cx || `${fromSym}/${toSym}`;

  let cancelGasTotal = 0n;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const useGp = await _submitGasPrice(provider, quote);
    const gl = _gasLimit(quote);
    const txReq = {
      to: quote.to,
      data: quote.data,
      value: BigInt(quote.value || 0),
      gasLimit: gl,
      gasPrice: useGp,
      type: config.TX_TYPE,
    };
    log.info(
      "[rebalance] %s: swap (aggregator attempt %d/%d)" +
        " %s -> %s data=%d bytes gasLimit=%s gasPrice=%s (type 0)",
      ctx,
      attempt,
      maxAttempts,
      fromSym,
      toSym,
      (quote.data || "").length,
      String(gl),
      String(useGp),
    );
    // Nonce is managed by NonceManager — never fetch manually.
    const tx = await _sendSwap(
      signer,
      txReq,
      "[aggregator] swap " + fromSym + "->" + toSym,
    );
    log.info(
      "[aggregator] %s: Step 6 swap TX submitted, %s -> %s hash= %s nonce=%d type=%s" +
        " gasPrice=%s maxFee=%s maxPrio=%s",
      ctx,
      fromSym,
      toSym,
      tx.hash,
      tx.nonce,
      String(tx.type),
      String(tx.gasPrice ?? "—"),
      String(tx.maxFeePerGas ?? "—"),
      String(tx.maxPriorityFeePerGas ?? "—"),
    );
    try {
      /*- Through the endpoint gateway, not a bare `tx.wait()`. A bare
       *  wait asks only the endpoint that broadcast the swap and cannot
       *  follow a failover, so an endpoint going quiet rejected with its
       *  own error — which is neither `_AGG_TIMEOUT` nor a revert, so
       *  the catch below rethrew it. That skipped the cancel, left the
       *  nonce held by a swap still in the mempool, and reached
       *  `swapIfNeeded` unflagged, where an unflagged error means "no
       *  swap happened" and the router fallback swaps the same balance
       *  again. `waitForReceipt` keeps asking other endpoints instead,
       *  so an unreachable endpoint is no longer one of the outcomes and
       *  only the two this catch already handles can arrive. */
      const r = await sendTx.waitForReceipt({
        tx,
        label: "[aggregator] swap " + fromSym + "->" + toSym,
        ms: waitMs,
        sentinel: "_AGG_TIMEOUT",
      });
      const costPls = (Number(receiptGasWei(r)) / 1e18).toFixed(4);
      log.info(
        "[rebalance] %s: swap (aggregator) confirmed %s -> %s" +
          " gasUsed=%s cost=%s PLS",
        ctx,
        fromSym,
        toSym,
        String(r.gasUsed),
        costPls,
      );
      return { txHash: r.hash, gasCostWei: receiptGasWei(r) + cancelGasTotal };
    } catch (err) {
      if (err.message !== "_AGG_TIMEOUT" && err.code !== "CALL_EXCEPTION")
        throw err;
      const outcome = await _handleSwapError(
        err,
        signer,
        provider,
        tx,
        waitMs,
        fromSym,
        toSym,
        useGp,
      );
      cancelGasTotal += outcome.cancelGasWei;
      const landed = _resolveSwapOutcome({
        outcome,
        tx,
        waitMs,
        cancelGasTotal,
        ctx,
        fromSym,
        toSym,
      });
      if (landed) return landed;
      if (attempt < maxAttempts) {
        quote = await _fetchQuote(tokenIn, tokenOut, amountIn, slippagePct);
        log.info(
          "[rebalance] %s: swap (aggregator) re-quoted %s -> %s buy=%s",
          ctx,
          fromSym,
          toSym,
          quote.buyAmount,
        );
      }
    }
  }
  const exhausted = new Error(
    "Aggregator swap failed after " + maxAttempts + " attempts",
  );
  /*- Reachable only once an attempt reported the nonce spent, so nothing is
   *  pending and the fallback is safe — but the cancels along the way were
   *  broadcast and their gas is spent.  Same seam the unsettled error uses. */
  exhausted.cancelGasCostWei = cancelGasTotal;
  throw exhausted;
}

/**
 * Swap via 9mm DEX Aggregator (primary path — lowest slippage).
 * Fetches a quote, approves, re-quotes, then submits with
 * cancel-and-requote retry on timeout.
 * @param {object} signer     ethers Signer.
 * @param {object} ethersLib  ethers library.
 * @param {object} params     Swap parameters.
 * @param {function} balanceDiff  Balance-diff wrapper.
 * @returns {Promise<{amountOut: bigint, txHash: string|null, gasCostWei: bigint, swapSources: string}>}
 */
async function swapViaAggregator(signer, ethersLib, params, balanceDiff) {
  const {
    tokenIn,
    tokenOut,
    amountIn,
    slippagePct,
    recipient,
    symbolIn,
    symbolOut,
    approvalMultiple,
    _attempts,
    _attemptLabel,
    logCtx: ctx,
  } = params;
  const symIn = symbolIn || tokenIn.slice(0, 10);
  const symOut = symbolOut || tokenOut.slice(0, 10);
  /*- 6-field log context prefix per feedback-log-full-context.  Built
   *  in rebalancer-execute.js _swapAndAdjust and threaded through
   *  swapIfNeeded params.  Fallback to a synthetic prefix keeps tests
   *  that don't thread logCtx readable rather than printing "undefined". */
  const cx = ctx || `${symIn}/${symOut}`;
  const signerAddr = await signer.getAddress();
  const quote = await _fetchQuote(tokenIn, tokenOut, amountIn, slippagePct);
  const impact = parseFloat(quote.estimatedPriceImpact) || 0;
  const slip = slippagePct ?? _DEFAULTS.slippagePct;
  /*- Display label is the AGGREGATOR_LABEL constant defined at the top
   *  of this module.  The raw per-pool list is still logged below for
   *  diagnostics but never surfaced to the UI. */
  const sources = AGGREGATOR_LABEL;
  const rawPools =
    (quote.sources || [])
      .filter((s) => s.proportion !== "0")
      .map((s) => s.name)
      .join(", ") || "unknown";
  log.info(
    "[rebalance] %s: swap (aggregator) %s -> %s" +
      " quote buy=%s guaranteed=%s impact=%s%% sources=%s pools=%s",
    cx,
    symIn,
    symOut,
    quote.buyAmount,
    quote.guaranteedPrice || "—",
    impact.toFixed(2),
    sources,
    rawPools,
  );
  _checkSwapImpact(impact, slip, _attempts, _attemptLabel || "9mm Aggregator");
  const tokenC = new ethersLib.Contract(tokenIn, ERC20_ABI, signer);
  let aggApprovalGas = await _ensureAllowance(
    tokenC,
    signerAddr,
    quote.allowanceTarget,
    amountIn,
    approvalMultiple,
  );
  const fresh = await _fetchQuote(tokenIn, tokenOut, amountIn, slippagePct);
  if (fresh.allowanceTarget !== quote.allowanceTarget)
    aggApprovalGas += await _ensureAllowance(
      tokenC,
      signerAddr,
      fresh.allowanceTarget,
      amountIn,
      approvalMultiple,
    );
  const provider = signer.provider || signer;
  return balanceDiff(ethersLib, tokenOut, recipient, provider, async () => {
    const result = await _sendWithRetry(
      signer,
      provider,
      fresh,
      slippagePct,
      tokenIn,
      tokenOut,
      amountIn,
      symIn,
      symOut,
      cx,
    );
    result.gasCostWei = (result.gasCostWei || 0n) + (aggApprovalGas || 0n);
    result.swapSources = sources;
    log.info("[route-trace] aggregator swap sources=%s", sources || "(empty)");
    return result;
  });
}

module.exports = {
  swapViaAggregator,
  AGGREGATOR_LABEL,
  _aggregatorBase,
  _gasLimit,
  _baseSigner,
  _getGasPrice,
  _handleSwapError,
  _resolveSwapOutcome,
  _submitGasPrice,
  _setWaitMsForTests, // exported for tests
};
