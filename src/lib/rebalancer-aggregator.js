/**
 * @file rebalancer-aggregator.js
 * @description Aggregator swap path for the rebalancer — on PulseChain,
 *   the Watergun Aggregator.
 *   Fetches quotes from the aggregator API, submits TXs with
 *   cancel-and-requote retry on timeout. Used as the primary
 *   swap path; V3 router in rebalancer-swap.js is the fallback.
 *
 *   Chain-specific tunables (cancel gas multiplier, wait timeout,
 *   max attempts) are loaded from app-config/app-defaults-for-user-configurable/chains.json via config.CHAIN.
 *   The time limit on a quote request comes from the same file, through
 *   config.AGGREGATOR_QUOTE_TIMEOUT_MS, which checks it at startup.
 */

"use strict";

const config = require("./config");
const { log } = require("./log");
const { ERC20_ABI, _ensureAllowance } = require("./rebalancer-pools");
const {
  _checkSwapImpact,
  quoteImpactPct,
} = require("./rebalancer-swap-impact");
const { _retrySend, _retrySendTimed } = require("./tx-retry");
const { requestQuote } = require("./aggregator-quote-request");
const { aggregatorBaseUrlOf } = require("./aggregator-in-use");

const {
  settleNonce,
  resolveSwapOutcome,
} = require("./aggregator-nonce-settle");
const { signedTransactionHash } = require("./held-transaction");
const { receiptGasWei } = require("./receipt-gas");
const { addSpentGas } = require("./spent-gas");
/*- The classifier the retry layer uses, from the module that owns it: a
 *  failed send is safe to fall back from only when the node never admitted
 *  the transaction, and that bucket is its answer, not ours to restate. */
const {
  classifyRpcError,
  innerErrorMessage,
} = require("./rpc-error-classifier");
/*-
 *  For the receipt waits only. This module broadcasts its own swap and
 *  runs its own cancel-and-requote recovery, but reading a receipt means
 *  asking an endpoint, and which endpoint to ask is owned there.
 */
const sendTx = require("./send-transaction");
const { CANCEL_GAS_LIMIT } = require("./tx-speedup");

/** Chain-specific aggregator tunables from app-config/app-defaults-for-user-configurable/chains.json. */
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
 * Base url of the active chain's aggregator api, chain path included:
 * `https://swap.watergun.pro/api/aggregator/369` on PulseChain. The quote
 * path is appended to it.
 *
 * Each chain names its own aggregator, in its own `aggregator.url` in
 * chains.json, because both the vendor and its path differ by chain:
 * Watergun keys the path by chain id. An empty string means the chain has
 * no aggregator; `src/lib/config.js` refuses to start on an entry that gives
 * no url at all. Whether there is one is `src/lib/aggregator-in-use.js`'s
 * answer, and this is where the app asks it: the swap through
 * `_aggregatorBase`, and the "Route:" badge through
 * `primaryRouteLabel`, so the badge cannot name a route the swap does not
 * try.
 *
 * Read per call, not captured at load, so a test can point it elsewhere.
 *
 * @returns {string} Base url with no trailing slash, or "" for none.
 */
function aggregatorBaseUrl() {
  return aggregatorBaseUrlOf(config.AGGREGATOR_URL);
}

/**
 * The active chain's aggregator base url, for a quote request. A chain
 * with no aggregator throws here, and the throw reaches `swapIfNeeded` as
 * a failed quote, so the swap goes through the V3 router and the log says
 * why.
 *
 * @returns {string} Base url with no trailing slash.
 * @throws {Error} When the active chain configures no aggregator.
 */
function _aggregatorBase() {
  const base = aggregatorBaseUrl();
  if (base.length === 0) {
    throw new Error(
      `No aggregator configured for ${config.CHAIN_NAME} ` +
        `(chains.json → ${config.CHAIN_NAME}.aggregator.url); ` +
        "swapping through the V3 router instead.",
    );
  }
  return base;
}

/**
 * Display label for the aggregator route: the active chain's
 * `aggregator.name` in chains.json. Stamped onto `result.swapSources` on
 * every successful aggregator swap, and named by the Mission Control
 * "Route:" badge through `primaryRouteLabel`.
 *
 * Intentionally coarse: we do NOT drill into the underlying pools
 * (NineMM_V3, PulseX_V2, …) that the aggregator chose, because the
 * aggregator owns its routing decisions and exposing them misleads
 * users into thinking a direct pool swap was used.
 */
const AGGREGATOR_LABEL = config.AGGREGATOR_NAME;

/**
 * Fetch a quote from the active chain's aggregator.
 * @param {string} sellToken  Sell token address.
 * @param {string} buyToken   Buy token address.
 * @param {bigint} sellAmount Amount in base units.
 * @param {number} slippagePct Slippage as a percentage (e.g. 0.5).
 * @param {string} cx         The swap's six-field log context.
 * @returns {Promise<object>} Quote response.
 */
async function _fetchQuote(sellToken, buyToken, sellAmount, slippagePct, cx) {
  const slip = slippagePct / 100;
  /*-
   *  No takerAddress: given one, the aggregator builds different
   *  calldata, and that calldata reverts on-chain.
   */
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
  log.info("[aggregator] %s: GET %s", cx, url);
  const json = await requestQuote(url);
  if (config.VERBOSE) {
    log.info("[aggregator] %s: Response: %s", cx, JSON.stringify(json));
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
    log.info("[aggregator] %s: Response: %s", cx, JSON.stringify(brief));
  }
  return json;
}

/** Get gasPrice from provider fee data. */
async function _getGasPrice(provider) {
  const fd = await provider.getFeeData();
  return fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
}

/**
 * Compute the swap's gas limit: the quote's own gas figure, buffered by
 * the chain's `gasLimitMultiplier`. A quote that names no gas at all, which
 * the 0x api does not normally send, is given the chain's
 * `aggregator.gasUnitsWhenQuoteOmitsGas` instead. Both settings live in
 * chains.json, and `src/lib/config.js` refuses to start without them.
 */
function _gasLimit(quote) {
  const raw = Number(
    quote.gas || quote.estimatedGas || _agg.gasUnitsWhenQuoteOmitsGas,
  );
  return BigInt(Math.ceil(raw * config.CHAIN.gasLimitMultiplier));
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
 * Gas is `max(feeData × cancelGasMultiplier, sentGasPrice × speedUpGasBump)`,
 * both from chains.json, so the cancel always outbids the transaction it is
 * replacing — the same pattern as `_waitOrSpeedUp`. The send reuses the
 * stuck nonce, which is why it goes through `_baseSigner` to bypass the
 * NonceManager, and why `retryingTxWithSameNonce` tells `_retrySend` that a
 * "nonce too low" refusal means the original mined rather than that the send
 * needs recovery.
 *
 * It returns the hash and the receipt-or-null rather than a gas figure,
 * because the caller's next move turns on whether this nonce is now spent and
 * a number cannot carry that: zero wei is both a plausible cost and the value
 * an unconfirmed cancel would report. The wait goes through the shared
 * receipt gateway, bounded by `waitMs`, and any end other than a receipt
 * resolves to null, so a null receipt means only "no receipt yet", never
 * "cancelled". `settleNonce` turns that into an answer.
 *
 * @param {import('ethers').Signer} signer Signer, possibly a NonceManager.
 * @param {object} provider  Provider used for the fee-data read.
 * @param {number} nonce     The stuck nonce to occupy.
 * @param {number} waitMs    How long to wait for the cancel's receipt.
 * @param {bigint} sentGasPrice Gas price the pending TX was sent at.
 * @param {string} cx        The swap's six-field log context.
 * @returns {Promise<{hash: string, receipt: object|null}>}
 */
async function _cancelNonce(signer, provider, nonce, waitMs, sentGasPrice, cx) {
  const gp = await _getGasPrice(provider);
  const fromFee = BigInt(Math.ceil(Number(gp) * _agg.cancelGasMultiplier));
  const floor = BigInt(
    Math.ceil(Number(sentGasPrice) * config.CHAIN.speedUpGasBump),
  );
  const cancelGp = fromFee > floor ? fromFee : floor;
  // Bypass NonceManager — cancel TX must reuse the stuck nonce.
  const base = _baseSigner(signer);
  const addr = await base.getAddress();
  log.info(
    "[aggregator] %s: cancel nonce=%d: gasPrice=%s gasLimit=%s (type %s)",
    cx,
    nonce,
    String(cancelGp),
    String(CANCEL_GAS_LIMIT),
    String(config.TX_TYPE),
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
        gasLimit: CANCEL_GAS_LIMIT,
        type: config.TX_TYPE,
      }),
    "[aggregator] cancel nonce=" + nonce,
    {
      signer: base,
      retryingTxWithSameNonce: true,
      heldProviders: () => ({
        wait: base.provider,
        read: sendTx.getManagedReadProvider(),
      }),
    },
  );
  log.info(
    "[aggregator] %s: cancel: TX submitted, hash= %s nonce=%d gasPrice=%s",
    cx,
    c.hash,
    c.nonce,
    String(c.gasPrice ?? "—"),
  );
  const receipt = await sendTx
    .waitForReceipt({
      tx: c,
      label: "[aggregator] cancel nonce=" + nonce,
      ms: waitMs,
      sentinel: "_AGG_CANCEL_TIMEOUT",
    })
    .catch(() => null);
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
 * low" because the swap mined, or never broadcast at all because the txpool
 * is full or the retries ran out. ("Already known" is not one of them: the
 * cancel is pending, and `_retrySend` returns it to be waited on.) An error
 * leaving here is unflagged, and the caller's
 * router fallback reads unflagged as "no swap happened" and sends a second
 * one — so all of them hand the question to `settleNonce` and the chain.
 *
 * The caller needs three distinguishable answers and so gets an object rather
 * than a gas total: `swapReceipt` when the swap itself landed and must be
 * reported as the swap, `nonceSpent` when the slot is settled and a re-quote
 * at the next nonce is safe, and neither when the slot is still open — the
 * state in which a retry would risk a second swap of the same balance.
 * `spentGasWei` is carried alongside: the gas of whatever took the nonce
 * without swapping, a reverted swap or the cancel. It was paid either way and
 * belongs in the move's cost.
 *
 * @param {Error}  err      The error that ended the swap's wait.
 * @param {import('ethers').Signer} signer Signer, possibly a NonceManager.
 * @param {object} provider Read provider.
 * @param {object} tx       The submitted swap, for its `hash` and `nonce`.
 * @param {number} waitMs   Confirmation budget, reused for the cancel.
 * @param {string} fromSym  Sell-token symbol, for logs.
 * @param {string} toSym    Buy-token symbol, for logs.
 * @param {bigint} sentGasPrice Gas price the swap was sent at.
 * @param {string} cx       The swap's six-field log context.
 * @returns {Promise<{spentGasWei: bigint, swapReceipt: object|null,
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
  cx,
) {
  if (err.message !== "_AGG_TIMEOUT") {
    /*-
     *  A revert's error is ethers' CALL_EXCEPTION, which always carries
     *  the mined receipt: the swap consumed its nonce and paid for its gas
     *  while moving nothing.
     */
    log.warn(
      "[rebalance] %s: swap (aggregator): %s -> %s reverted" +
        " on-chain (gasUsed=%s) — re-quoting",
      cx,
      fromSym,
      toSym,
      String(err.receipt.gasUsed),
    );
    return {
      spentGasWei: receiptGasWei(err.receipt),
      swapReceipt: null,
      nonceSpent: true,
    };
  }
  log.warn(
    "[rebalance] %s: swap (aggregator): %s -> %s not confirmed" +
      " in %ds — cancelling nonce %d (%sx gas)",
    cx,
    fromSym,
    toSym,
    waitMs / 1000,
    tx.nonce,
    String(_agg.cancelGasMultiplier),
  );
  let cancel;
  try {
    cancel = await _cancelNonce(
      signer,
      provider,
      tx.nonce,
      waitMs,
      sentGasPrice,
      cx,
    );
  } catch (cancelErr) {
    /*-
     *  No cancel failure may rethrow from here.  An error leaving this
     *  function carries no `nonceUnsettled`, and the caller's router
     *  fallback reads an unflagged error as "no swap happened" and sends a
     *  second swap of the same balance — the defect this whole path
     *  exists to prevent, reached through the cancel instead of the swap.
     *
     *  Every way the cancel can fail is the same fact: this nonce is
     *  unexamined.  "Nonce too low" says something mined at this nonce,
     *  the swap or the cancel itself.  A full txpool, a refused gas
     *  price, or exhausted retries mean no cancel is pending at all.  None
     *  of them says what became of the swap, so all of them hand the
     *  question to `settleNonce` and the chain.
     */
    /*-
     *  A refusal still carries the cancel it refused, and its hash is the
     *  hash of any earlier copy that went through though its reply was
     *  lost (src/lib/held-transaction.js). Asked about it, the chain can say
     *  this cancel closed the slot, and the re-quote that is then safe
     *  is not refused as though the slot were still open.
     */
    cancel = { hash: signedTransactionHash(cancelErr), receipt: null };
    log.warn(
      "[rebalance] %s: swap (aggregator): cancel at nonce %d did not" +
        " confirm (%s) — settling from chain state%s",
      cx,
      tx.nonce,
      cancelErr.message,
      cancel.hash === null ? "" : " (refused cancel hash= " + cancel.hash + ")",
    );
  }
  // Re-sync NonceManager after cancel so its counter matches chain state.
  if (typeof signer.reset === "function") signer.reset();
  const settled = await settleNonce(provider, tx.hash, cancel);
  log.info(
    "[rebalance] %s: swap (aggregator): nonce %d — swap mined=%s," +
      " slot spent=%s",
    cx,
    tx.nonce,
    settled.swapReceipt !== null ? "yes" : "no",
    settled.nonceSpent ? "yes" : "no",
  );
  return settled;
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
 * the rebalance fails rather than risking the swap twice. An endpoint that
 * answers "already known" holds the swap already: the retry recovers it,
 * and it is waited on like any other.
 *
 * @param {import('ethers').Signer} signer Nonce-managed signer.
 * @param {object} txReq   Populated transaction request, without a nonce.
 * @param {string} label   Log label for the retry layer.
 * @returns {Promise<{tx: object, submittedAt: number}>} The submitted
 *   transaction, and when it was first submitted (`_retrySendTimed`).
 */
async function _sendSwap(signer, txReq, label) {
  try {
    return await _retrySendTimed(() => signer.sendTransaction(txReq), label, {
      signer,
      heldProviders: () => ({
        wait: sendTx.getCurrentRPC(),
        read: sendTx.getManagedReadProvider(),
      }),
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
 * aggregator `gasPriceMultiplier` is then applied so the submission sits
 * above the going rate rather than at it; `src/lib/config.js` refuses to start
 * without one. A quote without a gas price leaves the chain's own figure to
 * stand alone.
 *
 * @param {object} provider Provider for the fee-data read.
 * @param {object} quote    Aggregator quote, possibly carrying `gasPrice`.
 * @returns {Promise<bigint>} The gas price to submit at.
 */
async function _submitGasPrice(provider, quote) {
  const gp = await _getGasPrice(provider);
  const qgp = BigInt(quote.gasPrice || 0);
  const base = qgp > gp ? qgp : gp;
  return (base * BigInt(Math.round(_agg.gasPriceMultiplier * 1000))) / 1000n;
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
 * Each re-quote comes from `requote`, which also holds it to the
 * operator's slippage, so a quote failing that check throws here with
 * the nonce already settled.
 *
 * Reverted swaps and cancels are mined, so each is paid for whether or
 * not a later attempt lands. Their gas is summed as `spentGasWei` and
 * travels with whatever the loop ends with: added to the landed swap's
 * own gas, or put onto the error. Every error leaves the loop through one
 * catch, so none can leave without it, whichever step threw.
 *
 * Chain-specific tunables (waitMs, cancelGasMultiplier, maxAttempts)
 * come from app-config/app-defaults-for-user-configurable/chains.json.
 * The two token symbols and the log context arrive filled in from its
 * only caller, `swapViaAggregator`.
 */
async function _sendWithRetry(
  signer,
  provider,
  quote,
  requote,
  fromSym,
  toSym,
  ctx,
) {
  const waitMs = _waitMsForTests ?? _agg.waitMs;
  const maxAttempts = _agg.maxAttempts;

  let spentGasWei = 0n;
  try {
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
          " %s -> %s data=%d bytes gasLimit=%s gasPrice=%s (type %s)",
        ctx,
        attempt,
        maxAttempts,
        fromSym,
        toSym,
        (quote.data || "").length,
        String(gl),
        String(useGp),
        String(config.TX_TYPE),
      );
      /*-
       *  The wait below is timed from when the swap waited on was first
       *  submitted: the attempt that was accepted, so a swap slow to send
       *  gets no more time than one taken at once, or, for a swap an
       *  endpoint answered "already known" on a resubmission, the first
       *  attempt, which is the one that reached it. Either way the cancel
       *  and the fresh quote follow on time. The retries' waits between
       *  failed attempts are not counted, since no swap was pending then.
       *  Nonce is managed by NonceManager — never fetch manually.
       */
      const { tx, submittedAt } = await _sendSwap(
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
        /*-
         *  Through the endpoint gateway rather than a bare `tx.wait()`,
         *  which polls only the endpoint that broadcast the swap and
         *  cannot follow a failover. That matters here more than anywhere
         *  else in the app, because of what the catch below can do with an
         *  error it does not recognise: it rethrows, which skips the
         *  cancel and leaves the error unflagged, and `swapIfNeeded` reads
         *  an unflagged error as "no swap happened" and lets the router
         *  swap the same balance a second time. So an unreachable endpoint
         *  must not be one of the outcomes, and through the gateway it is
         *  not — the question moves to another endpoint, leaving the two
         *  things this catch acts on: its own deadline, and a revert,
         *  which is an answer about the swap itself. Anything else, such
         *  as an endpoint answering the check with an error message, is
         *  logged with the swap's hash and that message, and rethrown, so
         *  the swap goes to the V3 router fallback: by the operator's
         *  decision, such a swap almost certainly did not go through.
         */
        const r = await sendTx.waitForReceipt({
          tx,
          label: "[aggregator] swap " + fromSym + "->" + toSym,
          ms: Math.max(0, waitMs - (Date.now() - submittedAt)),
          sentinel: "_AGG_TIMEOUT",
        });
        const costNative = (Number(receiptGasWei(r)) / 1e18).toFixed(4);
        log.info(
          "[rebalance] %s: swap (aggregator) confirmed %s -> %s" +
            " gasUsed=%s cost=%s %s",
          ctx,
          fromSym,
          toSym,
          String(r.gasUsed),
          costNative,
          config.CHAIN.nativeCurrencySymbol,
        );
        return {
          txHash: r.hash,
          gasCostWei: receiptGasWei(r) + spentGasWei,
          receipt: r,
        };
      } catch (err) {
        if (err.message !== "_AGG_TIMEOUT" && err.code !== "CALL_EXCEPTION") {
          const why = innerErrorMessage(err);
          log.warn(
            "[rebalance] %s: aggregator swap %s -> %s was sent, hash= %s," +
              " but checking for its confirmation failed (%s): %s" +
              " — leaving the swap to the V3 router fallback",
            ctx,
            fromSym,
            toSym,
            tx.hash,
            err.code ?? "no error code",
            why,
          );
          throw err;
        }
        const outcome = await _handleSwapError(
          err,
          signer,
          provider,
          tx,
          waitMs,
          fromSym,
          toSym,
          useGp,
          ctx,
        );
        spentGasWei += outcome.spentGasWei;
        const landed = resolveSwapOutcome({
          outcome,
          tx,
          waitMs,
          spentGasWei,
          ctx,
          fromSym,
          toSym,
        });
        if (landed) return landed;
        if (attempt < maxAttempts) quote = await requote("re-quoted");
      }
    }
    /*-
     *  Reachable only once every attempt reported its nonce spent, so
     *  nothing is pending and the router fallback is safe.
     */
    throw new Error(
      "Aggregator swap failed after " + maxAttempts + " attempts",
    );
  } catch (err) {
    throw addSpentGas(err, spentGasWei);
  }
}

/**
 * Swap via the active chain's aggregator (primary path — lowest slippage).
 * Fetches a quote, approves, re-quotes, then submits with
 * cancel-and-requote retry on timeout.
 *
 * The result's `gasCostWei` counts every transaction the attempt paid
 * for: the approvals, any reverted swaps and cancels, and the swap that
 * landed. An error thrown from here carries the same field, for what was
 * paid before it failed (see `src/lib/spent-gas.js`).
 *
 * @param {object} signer     ethers Signer.
 * @param {object} ethersLib  ethers library.
 * @param {object} params     Swap parameters.
 * @param {function} balanceDiff  Balance-diff wrapper.
 * @returns {Promise<{amountOut: bigint, txHash: string|null, gasCostWei: bigint, swapSources: string, exchange: {sent: bigint, received: bigint}|null}>}
 *   `exchange` is the swap's own, read from the receipt of the swap that
 *   landed (src/lib/rebalancer-swap-balance.js).
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
    /*-
     *  The six-field log context every swap line carries, built by each
     *  caller — the rebalance, its corrective swaps and the compound —
     *  and threaded through `swapIfNeeded`.
     */
    logCtx: cx,
  } = params;
  const symIn = symbolIn || tokenIn.slice(0, 10);
  const symOut = symbolOut || tokenOut.slice(0, 10);
  const signerAddr = await signer.getAddress();
  const quote = await _fetchQuote(tokenIn, tokenOut, amountIn, slippagePct, cx);
  const impact = quoteImpactPct(quote, cx, "quote", symIn, symOut);
  const slip = slippagePct;
  /**
   * Every quote that may be sent is held to the operator's slippage,
   * not only this first one. The approval below can take minutes, and a
   * re-quote follows a timeout or a revert, so the pool a later quote
   * prices against need not be the one this quote saw. The slippage in
   * a quote's calldata bounds the output only against that quote's own
   * price, which already includes its impact; this check is what holds
   * the swap to the slippage setting against the pool's price.
   */
  const requote = async (how) => {
    const q = await _fetchQuote(tokenIn, tokenOut, amountIn, slippagePct, cx);
    const qImpact = quoteImpactPct(q, cx, how, symIn, symOut);
    log.info(
      "[rebalance] %s: swap (aggregator) %s %s -> %s buy=%s impact=%s%%",
      cx,
      how,
      symIn,
      symOut,
      q.buyAmount,
      qImpact.toFixed(2),
    );
    _checkSwapImpact(qImpact, slip, _attempts, _attemptLabel);
    return q;
  };
  /*-
   *  Display label is AGGREGATOR_LABEL, the chain's aggregator name.
   *  The raw per-pool list is still logged below for diagnostics but
   *  never surfaced to the UI.
   */
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
  _checkSwapImpact(impact, slip, _attempts, _attemptLabel);
  const tokenC = new ethersLib.Contract(tokenIn, ERC20_ABI, signer);
  /*-
   *  An approval is mined before the fresh quote is fetched, so its gas is
   *  paid however the rest of the attempt goes. It is added to the swap's
   *  result when the swap lands, and to the error when anything after it
   *  fails: the fresh quote, a second approval, or the send.
   */
  let approvalGasWei = 0n;
  try {
    approvalGasWei += await _ensureAllowance(
      tokenC,
      signerAddr,
      quote.allowanceTarget,
      amountIn,
      approvalMultiple,
    );
    const fresh = await requote("fresh quote after approval");
    if (fresh.allowanceTarget !== quote.allowanceTarget)
      approvalGasWei += await _ensureAllowance(
        tokenC,
        signerAddr,
        fresh.allowanceTarget,
        amountIn,
        approvalMultiple,
      );
    const provider = signer.provider;
    const landed = await balanceDiff(
      ethersLib,
      tokenOut,
      recipient,
      provider,
      async () => {
        const result = await _sendWithRetry(
          signer,
          provider,
          fresh,
          requote,
          symIn,
          symOut,
          cx,
        );
        result.swapSources = sources;
        log.info("[route-trace] %s: aggregator swap sources=%s", cx, sources);
        return result;
      },
      tokenIn,
    );
    /*-
     *  Added here, outside the balance read, and only here: a read that
     *  fails after the swap carries the swap's own gas, and an approval
     *  counted inside the swap as well was counted twice.
     */
    return addSpentGas(landed, approvalGasWei);
  } catch (err) {
    throw addSpentGas(err, approvalGasWei);
  }
}

module.exports = {
  swapViaAggregator,
  AGGREGATOR_LABEL,
  aggregatorBaseUrl,
  _aggregatorBase,
  _gasLimit,
  _baseSigner,
  _getGasPrice,
  _handleSwapError,
  _submitGasPrice,
  _setWaitMsForTests, // exported for tests
};
