/**
 * @file rebalancer-pools.js
 * @description ABIs, constants, helpers, pool state, and liquidity
 * removal for the LP Ranger rebalancer.
 */

"use strict";

const { log } = require("./log");
const rangeMath = require("./range-math");
const config = require("./config");
const { PM_ABI } = require("./pm-abi");
const { _retrySend } = require("./tx-retry");
const { receiptGasWei } = require("./receipt-gas");
const sendTx = require("./send-transaction");
const { noteRpcResult } = require("./rpc-out-of-service");
const { retryRead } = require("./rpc-read-retry");
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
  return receiptGasWei(rcpt);
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
 * `_POOL_STATE_RETRY_DELAY_MS` wait before asking the SAME endpoint
 * again — moving to a different one is not a reason to wait.  After
 * spending that budget across every configured RPC it throws
 * `PoolStateUnavailableError`, wrapping the most recent underlying
 * error.  That error is what the dashboard renders as
 * `pool-info-unavailable` and what `bot-cycle.js` turns into a
 * `pollError`, so the budget exists to keep a Manage click answerable
 * rather than hanging.
 *
 * Endpoints come from the app's own failover, not from anything this
 * function keeps: the shared loop in `src/rpc-read-retry.js` asks
 * `sendTx.getCurrentRPC()` for the endpoint and reports failures to
 * `sendTx.failoverToNextRPC()`, so pool state follows selection exactly
 * as every other read does and contributes its outcomes to the same
 * rate.  It supplies only what is specific to it — the work, a bounded
 * budget, and the error raised when that budget is spent.
 *
 * The bound is the one departure from an ordinary read, which retries
 * for ever.  This answer gates a poll cycle and an interactive Manage
 * click, so running out has to produce something an operator can read
 * rather than a wait with no end.  Within the budget the retry stays on
 * whichever endpoint selection holds, waiting
 * `_POOL_STATE_RETRY_DELAY_MS` between tries, which is what gives a
 * blip lasting seconds time to clear.
 *
 * Spending the whole budget therefore takes a while, and deliberately:
 * selection moves on a failure rate rather than on each refusal, so a
 * blip keeps the retry on one endpoint and the wait applies to every
 * attempt after the first.  At the shipped three endpoints and two
 * attempts each that is five waits, so a Manage click against a sick
 * endpoint can sit for the better part of twenty seconds before the
 * dialog appears.  Waiting is the right trade for a poll — the blips
 * that cause it last seconds — and the dialog is what bounds it for
 * someone watching.
 *
 * @param {object} _passedProvider  UNUSED — kept so the six existing
 *   call sites (`bot-loop-detect.js`, `bot-cycle.js`, `rebalancer.js`,
 *   `position-details.js`, `bot-hodl-scan.js`, `hodl-baseline.js`) need
 *   no change.  The endpoint comes from `sendTx`.
 * @param {object} ethersLib    ethers module.
 * @param {object} opts         Same shape as `_getPoolStateOnce`.
 * @returns {Promise<object>}   Validated pool state.
 * @throws {PoolStateUnavailableError}  All RPCs exhausted.
 */
async function getPoolState(_passedProvider, ethersLib, opts) {
  return retryRead({
    tag: "pool-state",
    label: "getPoolState",
    /*- The whole read, not one call of it: a pool state is five reads
     *  that have to agree, so retrying them individually could pair a
     *  price from one endpoint with a pool address from another. */
    run: (provider) =>
      _getPoolStateOnce(provider, ethersLib, {
        ...opts,
        _rpcUrl: sendTx.urlOf(provider),
      }),
    /*- The loop needs a failure to enter on, and this caller has not
     *  attempted anything yet.  Only `isFailoverable` reads it, and
     *  every failure here is treated as the endpoint's. */
    err: new Error("pool state not read yet"),
    /*- Everything is retried, including the validation throws from
     *  `_getPoolStateOnce`: an endpoint that answers with nonsense —
     *  bad decimals being the case `pool-state-validate.js` exists for
     *  — is one that another endpoint may well answer correctly. */
    isFailoverable: () => true,
    failover: sendTx.failoverToNextRPC,
    current: sendTx.getCurrentRPC,
    urlOf: sendTx.urlOf,
    /*- This is the most frequent read in the bot, which makes it the
     *  best-informed witness to an endpoint's health.  Reporting is
     *  safe because a rate decides, not a report: the failures one call
     *  can produce cannot retire an endpoint by themselves. */
    note: (provider, ok) => noteRpcResult(sendTx.urlOf(provider), ok),
    /*- Bounded, unlike an ordinary read, because the answer gates a
     *  poll cycle and an interactive Manage click.  Exhausting it
     *  raises the error the dashboard renders as
     *  `pool-info-unavailable` and `bot-cycle.js` turns into a
     *  `pollError`, rather than leaving either waiting. */
    /*- Sized from the endpoints actually in service, not from
     *  `config.RPC_URLS`: the two agree at boot but `setRpcUrls` can
     *  re-point either, and a budget counting endpoints that are not
     *  there spends attempts on an endpoint it already tried. */
    /*- At least one attempt even with no endpoints in service.  A
     *  budget of zero would skip the loop entirely and raise
     *  `PoolStateUnavailableError` with a synthetic cause, reporting
     *  "pool unavailable" for what is really an rpc layer nobody
     *  initialised.  With one attempt the loop reaches `current()`,
     *  which is `sendTx.getCurrentRPC` and throws that programming
     *  fault by name — and does so uncaught, since `current()` is
     *  resolved before the `try`. */
    maxAttempts: Math.max(
      1,
      sendTx.endpointCount() * _POOL_STATE_ATTEMPTS_PER_URL,
    ),
    onExhausted: (attempts, lastErr) => {
      throw new PoolStateUnavailableError(attempts, lastErr);
    },
    /*- Applied only when the next attempt is the SAME endpoint, which
     *  is what gives a momentary blip time to clear — and with the
     *  rate deciding when to move, staying put is the common case for
     *  a blip lasting seconds.  Switching endpoints is not a reason to
     *  wait. */
    delayMs: _POOL_STATE_RETRY_DELAY_MS,
  });
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

  const gasCostWei = receiptGasWei(receipt);
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
  _MAX_IMPACT_PCT,
  // Helpers
  _checkSwapImpact,
  _bestAttemptError,
  _deadline,
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
