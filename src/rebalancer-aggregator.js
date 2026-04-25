/**
 * @file rebalancer-aggregator.js
 * @description 9mm DEX Aggregator swap path for the rebalancer.
 *   Fetches quotes from the aggregator API, submits TXs with
 *   cancel-and-requote retry on timeout. Used as the primary
 *   swap path; V3 router in rebalancer-swap.js is the fallback.
 *
 *   Chain-specific tunables (cancel gas multiplier, wait timeout,
 *   max attempts) are loaded from app-config/static-tunables/chains.json via config.CHAIN.
 */

"use strict";

const config = require("./config");
const {
  ERC20_ABI,
  _checkSwapImpact,
  _ensureAllowance,
} = require("./rebalancer-pools");

/** Chain-specific aggregator tunables from app-config/static-tunables/chains.json. */
const _agg = config.CHAIN.aggregator;

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
  const slip = (slippagePct ?? 0.5) / 100;
  // No takerAddress — the 9mm web UI omits it, and including it
  // causes the API to generate different calldata that reverts on-chain.
  const url =
    config.AGGREGATOR_URL +
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
  console.log("[aggregator] GET %s", url);
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
    console.log("[aggregator] Response: %s", JSON.stringify(json));
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
    console.log("[aggregator] Response: %s", JSON.stringify(brief));
  }
  return json;
}

/** Compute gas cost from a TX receipt. */
function _gasCost(r) {
  return (r.gasUsed ?? 0n) * (r.gasPrice ?? r.effectiveGasPrice ?? 0n);
}

/** Get gasPrice from provider fee data. */
async function _getGasPrice(provider) {
  const fd = await provider.getFeeData();
  return fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
}

/** Compute buffered gas limit from quote using chain config multiplier. */
function _gasLimit(quote) {
  const raw = Number(quote.gas || quote.estimatedGas || 300000);
  return BigInt(Math.ceil(raw * (_agg.gasLimitMultiplier || 2)));
}

/**
 * Cancel a pending nonce with a 0-value self-transfer at higher gas.
 * Uses max(feeData × cancelMultiplier, sentGasPrice × 1.5) so the
 * cancel always outbids the pending TX — same pattern as _waitOrSpeedUp.
 * @param {bigint} sentGasPrice Gas price the pending TX was sent at.
 * @returns {Promise<bigint>} Gas cost of the cancel TX in wei (0n if unconfirmed).
 */
/**
 * Unwrap a NonceManager to get the base signer for cancel TXs.
 * @param {import('ethers').Signer} signer
 * @returns {import('ethers').Signer}
 */
function _baseSigner(signer) {
  return signer.signer ?? signer;
}

async function _cancelNonce(signer, provider, nonce, waitMs, sentGasPrice) {
  const gp = await _getGasPrice(provider);
  const fromFee = BigInt(Math.ceil(Number(gp) * _agg.cancelGasMultiplier));
  const floor = ((sentGasPrice || 0n) * 3n) / 2n;
  const cancelGp = fromFee > floor ? fromFee : floor;
  // Bypass NonceManager — cancel TX must reuse the stuck nonce.
  const base = _baseSigner(signer);
  const addr = await base.getAddress();
  console.log(
    "[aggregator] cancel nonce %d: gasPrice=%s gasLimit=21000 (type 0)",
    nonce,
    String(cancelGp),
  );
  const c = await base.sendTransaction({
    to: addr,
    value: 0,
    nonce,
    gasPrice: cancelGp,
    gasLimit: 21000,
    type: config.TX_TYPE,
  });
  console.log(
    "[aggregator] cancel: TX submitted, hash= %s nonce=%d gasPrice=%s",
    c.hash,
    c.nonce,
    String(c.gasPrice ?? "—"),
  );
  const receipt = await Promise.race([
    c.wait().catch(() => null),
    new Promise((r) => setTimeout(r, waitMs)).then(() => null),
  ]);
  if (!receipt) return 0n;
  return (
    (receipt.gasUsed ?? 0n) *
    (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n)
  );
}

/**
 * Handle a retryable aggregator error (timeout or on-chain revert).
 * @returns {Promise<bigint>} Cancel gas cost in wei (0n if no cancel or revert).
 */
async function _handleSwapError(
  err,
  signer,
  provider,
  nonce,
  waitMs,
  fromSym,
  toSym,
  sentGasPrice,
) {
  if (err.message === "_AGG_TIMEOUT") {
    console.warn(
      "[rebalance] swap (aggregator): %s -> %s not confirmed" +
        " in %ds — cancelling nonce %d (%sx gas)",
      fromSym,
      toSym,
      waitMs / 1000,
      nonce,
      String(_agg.cancelGasMultiplier),
    );
    const cancelGas = await _cancelNonce(
      signer,
      provider,
      nonce,
      waitMs,
      sentGasPrice,
    );
    // Re-sync NonceManager after cancel so its counter matches chain state.
    if (typeof signer.reset === "function") signer.reset();
    console.log(
      "[rebalance] swap (aggregator): nonce %d cancelled" +
        " (or original confirmed)",
      nonce,
    );
    return cancelGas;
  }
  console.warn(
    "[rebalance] swap (aggregator): %s -> %s reverted" +
      " on-chain (gasUsed=%s) — re-quoting",
    fromSym,
    toSym,
    String(err.receipt?.gasUsed ?? "?"),
  );
  return 0n;
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
 * come from app-config/static-tunables/chains.json.
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
) {
  const waitMs = _agg.waitMs;
  const maxAttempts = _agg.maxAttempts;
  const fromSym = symIn || tokenIn.slice(0, 10);
  const toSym = symOut || tokenOut.slice(0, 10);

  let cancelGasTotal = 0n;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const gp = await _getGasPrice(provider);
    const qgp = BigInt(quote.gasPrice || 0);
    const base = qgp > gp ? qgp : gp;
    const m = _agg.gasPriceMultiplier || 1;
    const useGp = (base * BigInt(Math.round(m * 1000))) / 1000n;
    const gl = _gasLimit(quote);
    const txReq = {
      to: quote.to,
      data: quote.data,
      value: BigInt(quote.value || 0),
      gasLimit: gl,
      gasPrice: useGp,
      type: config.TX_TYPE,
    };
    console.log(
      "[rebalance] swap (aggregator attempt %d/%d):" +
        " %s -> %s data=%d bytes gasLimit=%s gasPrice=%s (type 0)",
      attempt,
      maxAttempts,
      fromSym,
      toSym,
      (quote.data || "").length,
      String(gl),
      String(gp),
    );
    // Nonce is managed by NonceManager — never fetch manually.
    const tx = await signer.sendTransaction(txReq);
    console.log(
      "[aggregator] Step 6: swap: TX submitted, %s -> %s hash= %s nonce=%d type=%s" +
        " gasPrice=%s maxFee=%s maxPrio=%s",
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
      const r = await Promise.race([
        tx.wait(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("_AGG_TIMEOUT")), waitMs),
        ),
      ]);
      const costPls = (Number(_gasCost(r)) / 1e18).toFixed(4);
      console.log(
        "[rebalance] swap (aggregator): confirmed %s -> %s" +
          " gasUsed=%s cost=%s PLS",
        fromSym,
        toSym,
        String(r.gasUsed),
        costPls,
      );
      return { txHash: r.hash, gasCostWei: _gasCost(r) + cancelGasTotal };
    } catch (err) {
      if (err.message !== "_AGG_TIMEOUT" && err.code !== "CALL_EXCEPTION")
        throw err;
      cancelGasTotal += await _handleSwapError(
        err,
        signer,
        provider,
        tx.nonce,
        waitMs,
        fromSym,
        toSym,
        useGp,
      );
      if (attempt < maxAttempts) {
        quote = await _fetchQuote(tokenIn, tokenOut, amountIn, slippagePct);
        console.log(
          "[rebalance] swap (aggregator): re-quoted" + " %s -> %s buy=%s",
          fromSym,
          toSym,
          quote.buyAmount,
        );
      }
    }
  }
  throw new Error("Aggregator swap failed after " + maxAttempts + " attempts");
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
  } = params;
  const symIn = symbolIn || tokenIn.slice(0, 10);
  const symOut = symbolOut || tokenOut.slice(0, 10);
  const signerAddr = await signer.getAddress();
  const quote = await _fetchQuote(tokenIn, tokenOut, amountIn, slippagePct);
  const impact = parseFloat(quote.estimatedPriceImpact) || 0;
  const slip = slippagePct ?? 0.5;
  /*- Display label is the AGGREGATOR_LABEL constant defined at the top
   *  of this module.  The raw per-pool list is still logged below for
   *  diagnostics but never surfaced to the UI. */
  const sources = AGGREGATOR_LABEL;
  const rawPools =
    (quote.sources || [])
      .filter((s) => s.proportion !== "0")
      .map((s) => s.name)
      .join(", ") || "unknown";
  console.log(
    "[rebalance] swap (aggregator): %s -> %s" +
      " quote buy=%s guaranteed=%s impact=%s%% sources=%s pools=%s",
    symIn,
    symOut,
    quote.buyAmount,
    quote.guaranteedPrice || "—",
    impact.toFixed(2),
    sources,
    rawPools,
  );
  _checkSwapImpact(impact, slip);
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
    );
    result.gasCostWei = (result.gasCostWei || 0n) + (aggApprovalGas || 0n);
    result.swapSources = sources;
    console.log(
      "[route-trace] aggregator swap sources=%s",
      sources || "(empty)",
    );
    return result;
  });
}

module.exports = {
  swapViaAggregator,
  AGGREGATOR_LABEL,
  _gasCost,
  _gasLimit,
  _baseSigner,
  _getGasPrice,
  _handleSwapError,
};
