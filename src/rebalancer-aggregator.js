/**
 * @file rebalancer-aggregator.js
 * @description 9mm DEX Aggregator swap path for the rebalancer.
 *   Fetches quotes from the aggregator API, submits TXs with
 *   cancel-and-requote retry on timeout. Used as the primary
 *   swap path; V3 router in rebalancer-swap.js is the fallback.
 */

'use strict';

const config = require('./config');
const {
  ERC20_ABI,
  _checkSwapImpact,
  _ensureAllowance,
} = require('./rebalancer-pools');

/** Fetch a quote from the 9mm DEX Aggregator. */
async function _fetchQuote(
  sellToken, buyToken, sellAmount, slippagePct, takerAddress) {
  const slip = (slippagePct ?? 0.5) / 100;
  const url = config.AGGREGATOR_URL + '/swap/v1/quote'
    + '?sellToken=' + sellToken + '&buyToken=' + buyToken
    + '&sellAmount=' + String(sellAmount)
    + '&slippagePercentage=' + slip
    + (takerAddress ? '&takerAddress=' + takerAddress : '');
  console.log('[aggregator] GET %s', url);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Aggregator API: HTTP ' + res.status);
  const json = await res.json();
  console.log('[aggregator] Response: %s',
    JSON.stringify(json));
  return json;
}

/** Compute gas cost from a TX receipt. */
function _gasCost(r) {
  return (r.gasUsed ?? 0n) * (r.gasPrice ?? r.effectiveGasPrice ?? 0n);
}

const _AGG_WAIT_MS = 30_000;
const _AGG_MAX_ATTEMPTS = 3;

/** Submit aggregator TX; cancel + re-quote if not confirmed in 30s. */
async function _sendWithRetry(
  signer, provider, quote, slippagePct,
  tokenIn, tokenOut, amountIn, taker,
) {
  for (let attempt = 1; attempt <= _AGG_MAX_ATTEMPTS; attempt++) {
    const fd = await provider.getFeeData();
    const gas = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
    const gl = BigInt(quote.estimatedGas || 300000);
    const maxPls = (Number(gas * gl) / 1e18).toFixed(4);
    console.log(
      '[rebalance] swap (aggregator attempt %d/%d):'
        + ' data=%d bytes maxGas=%s PLS',
      attempt, _AGG_MAX_ATTEMPTS,
      (quote.data || '').length, maxPls);
    const tx = await signer.sendTransaction({
      to: quote.to, data: quote.data,
      value: BigInt(quote.value || 0),
      gasLimit: gl, gasPrice: gas,
    });
    console.log(
      '[rebalance] swap (aggregator): TX hash=%s nonce=%d',
      tx.hash, tx.nonce);
    try {
      const r = await Promise.race([
        tx.wait(),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error('_AGG_TIMEOUT')),
          _AGG_WAIT_MS)),
      ]);
      const costPls = (Number(_gasCost(r)) / 1e18).toFixed(4);
      console.log(
        '[rebalance] swap (aggregator): confirmed'
          + ' gasUsed=%s cost=%s PLS',
        String(r.gasUsed), costPls);
      return { txHash: r.hash, gasCostWei: _gasCost(r) };
    } catch (err) {
      if (err.message !== '_AGG_TIMEOUT') throw err;
      console.warn(
        '[rebalance] swap (aggregator): not confirmed'
          + ' in %ds — cancelling nonce %d',
        _AGG_WAIT_MS / 1000, tx.nonce);
      const cancelGas = gas * 2n;
      const addr = await signer.getAddress();
      const c = await signer.sendTransaction({
        to: addr, value: 0, nonce: tx.nonce,
        gasPrice: cancelGas, gasLimit: 21000,
      });
      await c.wait().catch(() => {});
      console.log(
        '[rebalance] swap (aggregator): nonce %d cancelled',
        tx.nonce);
      if (attempt < _AGG_MAX_ATTEMPTS) {
        quote = await _fetchQuote(
          tokenIn, tokenOut, amountIn,
          slippagePct, taker);
        console.log(
          '[rebalance] swap (aggregator): re-quoted buy=%s',
          quote.buyAmount);
      }
    }
  }
  throw new Error(
    'Aggregator swap failed after ' + _AGG_MAX_ATTEMPTS + ' attempts');
}

/**
 * Swap via 9mm DEX Aggregator (primary path — lowest slippage).
 * Fetches a quote, approves, re-quotes, then submits with
 * cancel-and-requote retry on timeout.
 * @param {object} signer     ethers Signer.
 * @param {object} ethersLib  ethers library.
 * @param {object} params     Swap parameters.
 * @param {function} balanceDiff  Balance-diff wrapper.
 * @returns {Promise<{amountOut: bigint, txHash: string|null, gasCostWei: bigint}>}
 */
async function swapViaAggregator(signer, ethersLib, params, balanceDiff) {
  const { tokenIn, tokenOut, amountIn, slippagePct, recipient } = params;
  const signerAddr = await signer.getAddress();
  const quote = await _fetchQuote(
    tokenIn, tokenOut, amountIn, slippagePct, signerAddr);
  const impact = parseFloat(quote.estimatedPriceImpact) || 0;
  const slip = slippagePct ?? 0.5;
  const sources = (quote.sources || [])
    .filter((s) => s.proportion !== '0')
    .map((s) => s.name).join(', ') || 'unknown';
  console.log(
    '[rebalance] swap (aggregator): quote buy=%s impact=%s%% sources=%s',
    quote.buyAmount, impact.toFixed(2), sources);
  _checkSwapImpact(impact, slip);
  const tokenC = new ethersLib.Contract(tokenIn, ERC20_ABI, signer);
  await _ensureAllowance(tokenC, signerAddr,
    quote.allowanceTarget, amountIn);
  const fresh = await _fetchQuote(
    tokenIn, tokenOut, amountIn, slippagePct, signerAddr);
  if (fresh.allowanceTarget !== quote.allowanceTarget)
    await _ensureAllowance(tokenC, signerAddr,
      fresh.allowanceTarget, amountIn);
  const provider = signer.provider || signer;
  return balanceDiff(ethersLib, tokenOut,
    recipient, provider, async () => {
    return _sendWithRetry(
      signer, provider, fresh, slippagePct,
      tokenIn, tokenOut, amountIn, signerAddr);
  });
}

module.exports = { swapViaAggregator };
