/**
 * @file rebalancer-pools.js
 * @description ABIs, constants, helpers, pool state, and liquidity
 * removal for the 9mm v3 Position Manager rebalancer.
 */

"use strict";

const { log } = require("./log");
const rangeMath = require("./range-math");
const config = require("./config");
const { PM_ABI } = require("./pm-abi");
const { _retrySend } = require("./tx-retry");
const sendTx = require("./send-transaction");
const {
  PoolStateInvalidError,
  PoolStateUnavailableError,
  validateField: _validate,
  isAddressString,
  isPositiveInteger,
  isIntegerInRange,
  isAnyInteger,
  isFinitePositive,
  isPositiveBigIntish,
} = require("./pool-state-validate");

// ── ABI fragments ────────────────────────────────────────────────────────────

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
  "function feeAmountTickSpacing(uint24 fee) external view returns (int24)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const SWAP_ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
];

const ERC20_ABI = [
  "function decimals() external view returns (uint8)",
  "function balanceOf(address account) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

// ── Constants ────────────────────────────────────────────────────────────────

/*
 * _checkSwapImpact and _bestAttemptError moved to ./rebalancer-swap-impact.js
 * to keep this file under the project's max-lines cap.  Re-exported below
 * so existing imports of `rebalancer-pools` keep working unchanged.
 */
const {
  _checkSwapImpact,
  _bestAttemptError,
} = require("./rebalancer-swap-impact");

/** Maximum uint128 value used for the collect() call. */
const _MAX_UINT128 = 2n ** 128n - 1n;

/*- On-chain transaction deadline offset in seconds.  Stamped as
 *  `deadline = now + _DEADLINE_SECONDS` on every removeLiquidity /
 *  swap / mint calldata.  Source of truth is `tx.deadlineSec` in
 *  app-config/app-defaults-for-user-configurable/app-runtime.json —
 *  the `_comment` block on the `tx` group there explains the
 *  full deadline/cancel timing relationship.  Re-exported so
 *  tests and rebalancer.js can pin against it without knowing
 *  where the literal lives. */
const _DEADLINE_SECONDS = config.DEADLINE_SEC;

/** Minimum swap amount — skip swap if amountIn is below this threshold. */
const _MIN_SWAP_THRESHOLD = 1000n;

/** Valid V3 fee tiers (basis-point units). */
const V3_FEE_TIERS = [100, 500, 2500, 3000, 10000, 20000];

/*- Timeout (ms) before a pending TX is speed-up-replaced with higher
 *  gas.  No literal fallback per feedback_one_literal_per_shipped_default:
 *  config.TX_SPEEDUP_SEC is sourced from app-runtime.json via
 *  parsePositiveInt, so it is always a positive number at this point. */
const _SPEEDUP_TIMEOUT_MS = config.TX_SPEEDUP_SEC * 1000;
/** Timeout (ms) before a stuck TX is cancelled with a 0-value self-transfer. */
const _CANCEL_TIMEOUT_MS = config.TX_CANCEL_SEC * 1000;

/** Gas price multiplier for speed-up replacement TXs. */
const _SPEEDUP_GAS_BUMP = 1.5;

/** Maximum acceptable price impact (%) before the bot aborts the swap. */
const _MAX_IMPACT_PCT = 5;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return a deadline timestamp (current block time + offset).
 * @param {number} [offsetSeconds=_DEADLINE_SECONDS] Seconds from now.
 * @returns {bigint}
 */
function _deadline(offsetSeconds = _DEADLINE_SECONDS) {
  return BigInt(Math.floor(Date.now() / 1000) + offsetSeconds);
}

/**
 * Compute a cancel gas price that beats the stuck replacement TX.
 * Uses 2× the higher of current network gas or the stuck TX's gas.
 * @param {object} provider - ethers provider.
 * @param {bigint} stuckGas - Gas price of the stuck replacement TX.
 * @returns {Promise<bigint>}
 */
async function _cancelGasPrice(provider, stuckGas) {
  const fd = await provider.getFeeData();
  const cur = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
  const base = cur > stuckGas ? cur : stuckGas;
  return base * 2n;
}

/** Extract gas cost in wei from a TX receipt. */
function _receiptGas(rcpt) {
  return (rcpt.gasUsed ?? 0n) * (rcpt.gasPrice ?? rcpt.effectiveGasPrice ?? 0n);
}

/**
 * Unwrap a NonceManager to get the base signer for replacement/cancel TXs.
 * NonceManager overrides explicit nonces, so speed-up and cancel TXs
 * (which intentionally reuse a stuck nonce) must bypass it.
 * @param {import('ethers').Signer} signer
 * @returns {import('ethers').Signer}
 */
function _baseSigner(signer) {
  return signer.signer ?? signer;
}

/** Re-sync NonceManager after a cancel so its counter matches chain state. */
function _resetNonce(signer) {
  if (typeof signer.reset === "function") signer.reset();
}

/**
 * Wait for a TX to confirm, automatically speeding it up if it hasn't
 * confirmed within `_SPEEDUP_TIMEOUT_MS`.  Resends the same TX data with
 * the same nonce but a bumped gas price so miners/validators prefer it.
 * @param {import('ethers').TransactionResponse} tx  Submitted transaction.
 * @param {import('ethers').Signer} signer           Signer that sent the TX.
 * @param {string} label  Log label for diagnostics (e.g. 'removeLiq').
 * @returns {Promise<import('ethers').TransactionReceipt>}
 */
async function _waitOrSpeedUp(tx, signer, label) {
  const _extractReceipt = (result) => {
    if (result && result._type === "TransactionReceipt") return result;
    if (result && result.receipt) return result.receipt;
    return result;
  };
  const _tolerantWait = (t) =>
    t.wait().catch((e) => {
      if (e.code === "TRANSACTION_REPLACED" && e.receipt) {
        log.info(
          "[rebalance] %s: TX replaced, using replacement receipt",
          label,
        );
        return e.receipt;
      }
      throw e;
    });
  const _timeout = (ms, msg) =>
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(msg)), ms);
      t.unref?.();
      return t;
    });
  const startTime = Date.now();
  let timer1, timer2;

  // Phase 1: wait for confirmation, or speed-up after TX_SPEEDUP_SEC
  try {
    timer1 = _timeout(_SPEEDUP_TIMEOUT_MS, "_SPEEDUP");
    const receipt = await Promise.race([_tolerantWait(tx), timer1]);
    return _extractReceipt(receipt);
  } catch (err) {
    if (err.message !== "_SPEEDUP") throw err;
  }

  // Phase 2: speed-up with higher gas
  log.warn(
    "[rebalance] %s: TX %s not confirmed after %ds — speeding up",
    label,
    tx.hash,
    _SPEEDUP_TIMEOUT_MS / 1000,
  );
  const provider = signer.provider || signer;
  const fd = await provider.getFeeData();
  const curGas = fd.gasPrice ?? fd.maxFeePerGas ?? 0n,
    origGas = tx.gasPrice ?? tx.maxFeePerGas ?? 0n;
  const bumped = BigInt(
    Math.ceil(Number(curGas > origGas ? curGas : origGas) * _SPEEDUP_GAS_BUMP),
  );
  log.info(
    "[rebalance] %s: speedup origGas=%s curGas=%s bumped=%s nonce=%d",
    label,
    String(origGas),
    String(curGas),
    String(bumped),
    tx.nonce,
  );
  let replacement;
  try {
    // Bypass NonceManager — replacement TX must reuse the stuck nonce.
    // retryingTxWithSameNonce: true → "nonce too low" here means the
    // original TX has now mined; the recovery path (reset+retry) would
    // be wrong — we want to fall through and wait for the original.
    replacement = await _retrySend(
      () =>
        _baseSigner(signer).sendTransaction({
          type: config.TX_TYPE,
          to: tx.to,
          data: tx.data,
          value: tx.value,
          nonce: tx.nonce,
          gasLimit: tx.gasLimit,
          gasPrice: bumped,
        }),
      "[rebalance] " + label + " speedup nonce=" + tx.nonce,
      { signer, retryingTxWithSameNonce: true },
    );
    log.info(
      "[rebalance] %s: replacement TX submitted, hash= %s nonce=%d",
      label,
      replacement.hash,
      replacement.nonce,
    );
  } catch (sendErr) {
    log.error(
      "[rebalance] %s: speed-up send failed (nonce=%d): %s — waiting for original",
      label,
      tx.nonce,
      sendErr.message,
    );
    return _extractReceipt(await _tolerantWait(tx));
  }

  // Phase 3: wait for either to confirm, or cancel after _CANCEL_TIMEOUT_MS total
  const elapsed = Date.now() - startTime;
  const cancelIn = Math.max(10_000, _CANCEL_TIMEOUT_MS - elapsed);
  try {
    timer2 = _timeout(cancelIn, "_CANCEL");
    const receipt = await Promise.race([
      _tolerantWait(tx),
      _tolerantWait(replacement),
      timer2,
    ]);
    return _extractReceipt(receipt);
  } catch (err) {
    if (err.message !== "_CANCEL") throw err;
  }

  // Phase 4: cancel with 0-value self-transfer at the stuck nonce
  const totalMin = Math.round((Date.now() - startTime) / 60_000);
  log.error(
    "[rebalance] %s: TX STILL STUCK after %d min — cancelling nonce %d with 0-PLS self-transfer",
    label,
    totalMin,
    tx.nonce,
  );
  try {
    const cancelGas = await _cancelGasPrice(
      provider,
      replacement?.gasPrice ?? bumped ?? 0n,
    );
    // Bypass NonceManager — cancel TX must reuse the stuck nonce.
    // retryingTxWithSameNonce: true → "nonce too low" here means the
    // original (or a replacement) already mined; nothing to cancel.
    const base = _baseSigner(signer);
    const addr = await base.getAddress();
    const cancelTx = await _retrySend(
      () =>
        base.sendTransaction({
          type: config.TX_TYPE,
          to: addr,
          value: 0,
          nonce: tx.nonce,
          gasPrice: cancelGas,
          gasLimit: 21000,
        }),
      "[rebalance] " + label + " cancel nonce=" + tx.nonce,
      { signer: base, retryingTxWithSameNonce: true },
    );
    log.info(
      "[rebalance] %s: cancel TX submitted, hash= %s nonce=%d gasPrice=%s",
      label,
      cancelTx.hash,
      cancelTx.nonce,
      String(cancelGas),
    );
    const cancelReceipt = await cancelTx.wait();
    log.info(
      "[rebalance] %s: cancel TX confirmed in block %d — nonce %d is now free",
      label,
      cancelReceipt.blockNumber,
      tx.nonce,
    );
    _resetNonce(signer);
    // The original rebalance failed — throw to signal upstream
    const cancelErr = new Error(
      "Transaction cancelled after " +
        totalMin +
        " min (nonce " +
        tx.nonce +
        " freed via 0-PLS self-transfer)",
    );
    cancelErr.cancelled = true;
    cancelErr.cancelTxHash = cancelTx.hash;
    cancelErr.cancelGasCostWei = _receiptGas(cancelReceipt);
    throw cancelErr;
  } catch (cancelErr) {
    if (cancelErr.cancelled) throw cancelErr;
    log.error(
      "[rebalance] %s: cancel TX failed: %s — nonce %d may still be stuck",
      label,
      cancelErr.message,
      tx.nonce,
    );
    throw new Error(
      "Rebalance TX stuck and cancel failed: " + cancelErr.message,
      { cause: cancelErr },
    );
  }
}

/**
 * Ensure an ERC-20 allowance is at least `requiredAmount` for `spender`.
 *
 * When the current allowance is insufficient, approves
 * `requiredAmount × multiple`.  A multiple > 1 lets subsequent rebalances
 * and compounds skip the approve TX entirely — the short-circuit on
 * line 1 of this function returns 0n when the cached allowance already
 * covers the next swap.  Default `multiple` is 1n (back-compat: approve
 * exactly the amount needed).
 *
 * @param {import('ethers').Contract} tokenContract ERC-20 contract instance.
 * @param {string} owner   Owner address.
 * @param {string} spender Spender address.
 * @param {bigint} requiredAmount Minimum required allowance.
 * @param {bigint} [multiple=1n]  Approve this factor × `requiredAmount`.
 * @returns {Promise<bigint>} Gas cost in wei (0n if no approval needed).
 */
async function _ensureAllowance(
  tokenContract,
  owner,
  spender,
  requiredAmount,
  multiple = 1n,
) {
  const current = await tokenContract.allowance(owner, spender);
  if (current >= requiredAmount) return 0n;
  let m;
  if (typeof multiple === "bigint") m = multiple > 0n ? multiple : 1n;
  else if (typeof multiple === "number" && multiple > 0)
    m = BigInt(Math.floor(multiple));
  else m = 1n;
  const approveAmount = requiredAmount * m;
  if (m > 1n)
    log.info(
      "[rebalance] Step 7a: approve pre-sizing %sx (future rebalances/compounds will skip the approve TX while the cached allowance covers them)",
      String(m),
    );
  /*- ERC-20 approve routed through send-transaction.js so RPC failover
      and the chain-config gasLimitMultiplier apply.  Floor pinned to the
      standard 21k * multiplier baseline; estimate dominates in practice. */
  const { receipt: rcpt } = await sendTx.sendTransaction({
    populate: () =>
      tokenContract.approve.populateTransaction(spender, approveAmount),
    signer: tokenContract.runner,
    label: "[rebalance] approve",
  });
  return _receiptGas(rcpt);
}

// ── Exported functions ───────────────────────────────────────────────────────

/**
 * Single-attempt pool state fetch + per-field validation.  Throws
 * `PoolStateInvalidError` on the first failing field.  Any RPC-level
 * error (network failure, contract revert, etc.) propagates as-is and
 * is treated by the orchestrator as an attempt failure.
 *
 * @param {object} provider     ethers Provider to issue calls against.
 * @param {object} ethersLib    ethers module.
 * @param {object} opts
 * @param {string} opts.factoryAddress
 * @param {string} opts.token0
 * @param {string} opts.token1
 * @param {number} opts.fee
 * @param {string} opts._rpcUrl  The RPC URL behind `provider`; included
 *   in `PoolStateInvalidError` so the operator knows which endpoint
 *   produced the bad data.
 * @returns {Promise<{sqrtPriceX96: bigint, tick: number, tickSpacing: number, price: number, poolAddress: string, decimals0: number, decimals1: number}>}
 */
async function _getPoolStateOnce(
  provider,
  ethersLib,
  { factoryAddress, token0, token1, fee, _rpcUrl },
) {
  const { Contract, ZeroAddress } = ethersLib;
  const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(token0, token1, fee);

  /*- poolAddress must be a defined string of the right shape AND not
   *  the zero-address sentinel that the factory returns when no pool
   *  exists for the (token0, token1, fee) triple. */
  _validate("poolAddress", poolAddress, isAddressString, _rpcUrl);
  _validate("poolAddress", poolAddress, (x) => x !== ZeroAddress, _rpcUrl);

  const pool = new Contract(poolAddress, POOL_ABI, provider);
  const token0Contract = new Contract(token0, ERC20_ABI, provider);
  const token1Contract = new Contract(token1, ERC20_ABI, provider);

  const [slot0, rawDec0, rawDec1, rawTickSpacing] = await Promise.all([
    pool.slot0(),
    token0Contract.decimals(),
    token1Contract.decimals(),
    factory.feeAmountTickSpacing(fee),
  ]);

  /*- Coerce raw RPC return values (BigInt / number) to plain Numbers so
   *  the predicates below operate on a stable type.  Number(undefined)
   *  is NaN — caught by the integer-range check rather than by an
   *  early `undefined` short-circuit. */
  const decimals0 = Number(rawDec0);
  const decimals1 = Number(rawDec1);
  const tickSpacing = Number(rawTickSpacing);
  const tick = Number(slot0.tick);
  const sqrtPriceX96 = slot0.sqrtPriceX96;

  /*- ERC-20 decimals must fit in uint8 (0-255 per the contract type),
   *  but the practical upper bound is much lower; we follow the
   *  defacto cap of 77 (just above the largest value seen in the wild,
   *  e.g. 18 for most tokens, up to 36 for some pegged-stablecoin
   *  representations). */
  _validate("decimals0", decimals0, (x) => isIntegerInRange(x, 0, 77), _rpcUrl);
  _validate("decimals1", decimals1, (x) => isIntegerInRange(x, 0, 77), _rpcUrl);

  _validate("tickSpacing", tickSpacing, isPositiveInteger, _rpcUrl);

  /*- `tick` is a signed int24 — negative values are valid for prices
   *  below 1.0001^0.  Only the integer-ness matters. */
  _validate("tick", tick, isAnyInteger, _rpcUrl);

  /*- `sqrtPriceX96` arrives as a BigInt from ethers v6.  Reject zero
   *  / negative values (the pool is uninitialised or the RPC returned
   *  garbage). */
  _validate("sqrtPriceX96", sqrtPriceX96, isPositiveBigIntish, _rpcUrl);

  const price = rangeMath.sqrtPriceX96ToPrice(
    sqrtPriceX96,
    decimals0,
    decimals1,
  );

  /*- `price` is derived from the validated sqrtPriceX96 + decimals, so
   *  a NaN / non-finite / non-positive value here means the math
   *  helper produced something unusable — guard the downstream
   *  consumers (which divide and multiply by `price`). */
  _validate("price", price, isFinitePositive, _rpcUrl);

  return {
    sqrtPriceX96,
    tick,
    tickSpacing,
    price,
    poolAddress,
    decimals0,
    decimals1,
  };
}

/*- Configuration knobs for the retry orchestrator below.  Wait of 3 s
 *  between attempts is short enough that an interactive Manage click
 *  feels responsive (worst case ~10 s for a 2-RPC × 2-attempt
 *  exhaustion) but long enough that a momentary RPC blip has time to
 *  resolve before the retry.  `_POOL_STATE_RETRY_DELAY_MS` is `let`
 *  + mutable via `_setRetryDelayForTests` so unit tests can drop the
 *  delay to zero without changing the orchestrator's logic. */
let _POOL_STATE_RETRY_DELAY_MS = 3000;
const _POOL_STATE_ATTEMPTS_PER_URL = 2;

/** Test-only helper: override the inter-retry delay (default 3 s). */
function _setRetryDelayForTests(ms) {
  _POOL_STATE_RETRY_DELAY_MS = ms;
}

/**
 * Fetch current pool state (price, tick, decimals, tickSpacing) from
 * on-chain contracts.
 *
 * `tickSpacing` is read fresh from `factory.feeAmountTickSpacing(fee)` on
 * every call — never cached.  Hardcoded fee→spacing maps drift out of
 * sync with reality on V3 forks (9mm Pro adds non-standard tiers like
 * fee=20000 → spacing=400 that upstream Uniswap doesn't define), and
 * cached values across invocations would persist any error or
 * factory-governance change indefinitely.  The extra RPC call is
 * negligible compared to the rest of a rebalance and keeps the
 * pool-state snapshot internally consistent.
 *
 * Validation + retry contract
 * ───────────────────────────
 * Each attempt validates every returned field (`PoolStateInvalidError`
 * on any failure — see `_getPoolStateOnce`).  An attempt that fails
 * for any reason (invalid data, RPC error, network timeout) is
 * retried: each configured RPC is tried up to
 * `_POOL_STATE_ATTEMPTS_PER_URL` times, with a
 * `_POOL_STATE_RETRY_DELAY_MS` wait before each retry.  After
 * exhausting every configured RPC the orchestrator throws
 * `PoolStateUnavailableError`, wrapping the most recent underlying
 * error.
 *
 * The retry orchestrator constructs fresh `JsonRpcProvider` instances
 * per RPC URL (read from `config.RPC_URL` + `config.RPC_URL_FALLBACK`)
 * rather than going through `sendTx`'s managed-provider proxy.  This
 * lets the orchestrator target a specific RPC for each retry without
 * mutating `sendTx`'s persistent failover state (which would affect
 * every other concurrent read for a full hour).  The `provider`
 * parameter is retained for backward source compatibility with the
 * existing call sites but is not used internally.
 *
 * @param {object} _provider     UNUSED — kept for source-compat with
 *   existing callers (`bot-loop-detect.js`, `bot-cycle.js`,
 *   `rebalancer.js`, `position-details.js`, `bot-hodl-scan.js`,
 *   `hodl-baseline.js`).  The orchestrator builds its own per-URL
 *   providers.
 * @param {object} ethersLib    ethers module.
 * @param {object} opts         Same shape as `_getPoolStateOnce`.
 * @returns {Promise<object>}   Validated pool state.
 * @throws {PoolStateUnavailableError}  All RPCs exhausted.
 */
async function getPoolState(passedProvider, ethersLib, opts) {
  /*- `config.RPC_URL_FALLBACK` may be empty in single-RPC setups;
   *  `.filter(Boolean)` drops the empty entry so we don't try to build
   *  a provider for an empty URL.  When `chains.json` / .env later
   *  grows array-style fallbacks, only this line needs to change. */
  const urls = [config.RPC_URL, config.RPC_URL_FALLBACK].filter(Boolean);
  let attemptCount = 0;
  let lastErr = null;
  for (const url of urls) {
    for (let attempt = 1; attempt <= _POOL_STATE_ATTEMPTS_PER_URL; attempt++) {
      attemptCount++;
      if (attempt > 1)
        await new Promise((r) => setTimeout(r, _POOL_STATE_RETRY_DELAY_MS));
      try {
        /*- Construct a fresh per-URL provider when ethersLib supports
         *  it (real production ethers).  Fall back to the caller's
         *  passed provider when the ethers lib is a test mock without
         *  a `JsonRpcProvider` constructor — same retry budget, just
         *  against the single mock provider instead of N fresh ones. */
        let provider;
        try {
          provider = new ethersLib.JsonRpcProvider(url);
        } catch {
          provider = passedProvider;
        }
        return await _getPoolStateOnce(provider, ethersLib, {
          ...opts,
          _rpcUrl: url,
        });
      } catch (err) {
        lastErr = err;
        log.warn(
          "[pool-state] rpc=%s attempt=%d/%d failed: %s",
          url,
          attempt,
          _POOL_STATE_ATTEMPTS_PER_URL,
          err.message,
        );
      }
    }
  }
  throw new PoolStateUnavailableError(attemptCount, lastErr);
}

/**
 * Remove all liquidity from a V3 NFT position and collect tokens.
 *
 * Uses balance-diff to determine collected amounts (more robust than
 * parsing logs, which can fail if the ABI event signature doesn't match
 * the on-chain contract exactly).
 */
/*- Read chains.json's contracts.positionManager.mintGasLimit for the
 *  active chain and throw if missing/invalid.  No literal fallback per
 *  feedback_one_literal_per_shipped_default — chains.json is the sole
 *  source of truth.  Shared between `removeLiquidity` (multicall
 *  decrease+collect floor) and `rebalancer.js#mintPosition`. */
function _resolveMintGasFloor() {
  const v = config.CHAIN.contracts?.positionManager?.mintGasLimit;
  if (typeof v !== "number" || v <= 0) {
    throw new Error(
      "[rebalancer-pools] contracts.positionManager.mintGasLimit missing/invalid for " +
        `${config.CHAIN?.displayName ?? "?"} — must be a positive number in chains.json`,
    );
  }
  return BigInt(v);
}

async function removeLiquidity(
  signer,
  ethersLib,
  {
    positionManagerAddress,
    tokenId,
    liquidity,
    recipient,
    deadline,
    token0,
    token1,
  },
) {
  const { Contract } = ethersLib;
  const pm = new Contract(positionManagerAddress, PM_ABI, signer);
  const provider = signer.provider ?? signer;
  const dl = deadline ?? _deadline();

  let bal0Before = 0n,
    bal1Before = 0n;
  if (token0 && token1) {
    const t0 = new Contract(token0, ERC20_ABI, provider),
      t1 = new Contract(token1, ERC20_ABI, provider);
    [bal0Before, bal1Before] = await Promise.all([
      t0.balanceOf(recipient),
      t1.balanceOf(recipient),
    ]);
    log.info(
      "[rebalance] removeLiq: walletBefore0=%s walletBefore1=%s",
      String(bal0Before),
      String(bal1Before),
    );
  }

  // Bundle decreaseLiquidity + collect into a single atomic multicall,
  // matching the pattern the 9mm Pro UI uses.  This ensures no state can
  // change between the two operations and eliminates rounding dust that
  // can remain when they run as separate transactions.
  const decreaseData = pm.interface.encodeFunctionData("decreaseLiquidity", [
    { tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline: dl },
  ]);
  const collectData = pm.interface.encodeFunctionData("collect", [
    {
      tokenId,
      recipient,
      amount0Max: _MAX_UINT128,
      amount1Max: _MAX_UINT128,
    },
  ]);
  /*- Atomic decrease+collect multicall routed through send-transaction.js
      so RPC failover and the chain-config gasLimitMultiplier apply.  The
      multicall path is gas-heavy (two PM operations bundled) — floor
      pinned to the position-manager mint floor as a safe upper bound;
      the multiplier × estimateGas almost always wins. */
  const _multicallFloor = _resolveMintGasFloor();
  const { receipt } = await sendTx.sendTransaction({
    populate: () =>
      pm.multicall.populateTransaction([decreaseData, collectData]),
    signer,
    floor: _multicallFloor,
    label: "[rebalance] removeLiq",
  });

  // Determine collected amounts via balance diff (robust across all ABIs)
  let amount0 = 0n,
    amount1 = 0n;
  if (token0 && token1) {
    const t0 = new Contract(token0, ERC20_ABI, provider),
      t1 = new Contract(token1, ERC20_ABI, provider);
    const [bal0After, bal1After] = await Promise.all([
      t0.balanceOf(recipient),
      t1.balanceOf(recipient),
    ]);
    log.info(
      "[rebalance] removeLiq: walletAfter0=%s walletAfter1=%s",
      String(bal0After),
      String(bal1After),
    );
    amount0 = bal0After - bal0Before;
    amount1 = bal1After - bal1Before;
  }
  if (amount0 === 0n && amount1 === 0n) {
    throw new Error(
      "Collected 0 tokens after removing liquidity — aborting to prevent empty mint",
    );
  }

  const gasCostWei =
    (receipt.gasUsed ?? 0n) *
    (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
  return { amount0, amount1, txHash: receipt.hash, gasCostWei };
}

/** Log swap direction with human-readable token symbols. */
function logSwapNeeded(desired, pos, ps, sym0, sym1) {
  const is0 = desired.swapDirection === "token0to1";
  const d = is0 ? ps.decimals0 : ps.decimals1;
  const from = is0
    ? sym0 || pos.token0.slice(0, 8)
    : sym1 || pos.token1.slice(0, 8);
  const to = is0
    ? sym1 || pos.token1.slice(0, 8)
    : sym0 || pos.token0.slice(0, 8);
  log.info(
    "[rebalance] Swap needed: %s %s -> %s (%s raw)",
    (Number(desired.swapAmount) / 10 ** d).toFixed(4),
    from,
    to,
    String(desired.swapAmount),
  );
}

// ── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  // ABIs
  FACTORY_ABI,
  POOL_ABI,
  SWAP_ROUTER_ABI,
  ERC20_ABI,
  PM_ABI,
  // Constants
  _MAX_UINT128,
  _DEADLINE_SECONDS,
  _MIN_SWAP_THRESHOLD,
  V3_FEE_TIERS,
  _SPEEDUP_TIMEOUT_MS,
  _CANCEL_TIMEOUT_MS,
  _SPEEDUP_GAS_BUMP,
  _MAX_IMPACT_PCT,
  // Helpers
  _checkSwapImpact,
  _bestAttemptError,
  _deadline,
  _waitOrSpeedUp,
  _ensureAllowance,
  _resolveMintGasFloor,
  // Functions
  getPoolState,
  PoolStateInvalidError,
  PoolStateUnavailableError,
  _getPoolStateOnce, // exported for tests
  _setRetryDelayForTests, // exported for tests
  removeLiquidity,
  logSwapNeeded,
  _retrySend,
  // Re-exported deps
  rangeMath,
  config,
};
