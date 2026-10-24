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
const { receiptGasWei } = require("./receipt-gas");
const { carryingGas } = require("./spent-gas");
const sendTx = require("./send-transaction");
const { noteRpcResult } = require("./rpc-out-of-service");
const { retryRead } = require("./rpc-read-retry");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const {
  PoolStateUnavailableError,
  validateField: _validate,
  isAddressString,
  isPositiveInteger,
  isTokenDecimals,
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

/** Maximum uint128 value used for the collect() call. */
const _MAX_UINT128 = 2n ** 128n - 1n;

/*-
 *  On-chain transaction deadline offset in seconds, stamped as
 *  `deadline = now + _DEADLINE_SECONDS` on the removeLiquidity, V3
 *  router swap, mint and compound deposit calldata (an aggregator swap
 *  carries the aggregator's own). Source of truth is `tx.deadlineSec` in
 *  app-config/app-defaults-for-user-configurable/app-runtime.json, whose
 *  `tx` comment explains the deadline and cancel timing. Exported so
 *  tests can pin against it without knowing where the literal lives.
 */
const _DEADLINE_SECONDS = config.DEADLINE_SEC;

/*-
 *  The least amount worth swapping, in the token's smallest unit:
 *  bot-config-defaults.json → minSwapAmountRaw. A swap below it is
 *  skipped.
 */
const _MIN_SWAP_THRESHOLD = BigInt(readBotConfigDefaults().minSwapAmountRaw);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return a deadline timestamp (this machine's clock + offset).
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
 * covers the next swap.
 *
 * @param {import('ethers').Contract} tokenContract ERC-20 contract instance.
 * @param {string} owner   Owner address.
 * @param {string} spender Spender address.
 * @param {bigint} requiredAmount Minimum required allowance.
 * @param {number} multiple  The `approvalMultiple` setting: approve this
 *   factor × `requiredAmount`.
 * @returns {Promise<bigint>} Gas cost in wei (0n if no approval needed).
 */
async function _ensureAllowance(
  tokenContract,
  owner,
  spender,
  requiredAmount,
  multiple,
) {
  const current = await tokenContract.allowance(owner, spender);
  if (current >= requiredAmount) return 0n;
  /*-
   *  Every caller passes the saved setting or its shipped default. A
   *  value saved by an older release, before the server checked it, can
   *  still be on disk, so anything but a positive number approves the
   *  amount itself.
   */
  const m =
    typeof multiple === "number" && multiple > 0
      ? BigInt(Math.floor(multiple))
      : 1n;
  const approveAmount = requiredAmount * m;
  if (m > 1n)
    log.info(
      "[rebalance] Step 7a: approve pre-sizing %sx (future rebalances/compounds will skip the approve TX while the cached allowance covers them)",
      String(m),
    );
  /*-
   *  ERC-20 approve routed through send-transaction.js so RPC failover
   *  and the chain-config gasLimitMultiplier apply. It names no floor of
   *  its own, so the chain's `gasLimitFloor` stands under the estimate.
   */
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

  /*-
   *  ERC-20 decimals fit in a uint8, but only a range far narrower is
   *  usable: `tokenDecimals` in setting-bounds.json, which says why.
   */
  _validate("decimals0", decimals0, isTokenDecimals, _rpcUrl);
  _validate("decimals1", decimals1, isTokenDecimals, _rpcUrl);

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

/*-
 *  The budget of the retry below: `boundedReadAttemptsPerEndpoint` and
 *  `boundedReadRetryDelayMs` in bot-config-defaults.json, which the
 *  re-open check's wallet read shares. The delay is `let`, set through
 *  `_setRetryDelayForTests`, so unit tests can drop it to zero without
 *  changing the retry's logic.
 */
const _BOUNDED_READ = readBotConfigDefaults();
let _POOL_STATE_RETRY_DELAY_MS = _BOUNDED_READ.boundedReadRetryDelayMs;
const _POOL_STATE_ATTEMPTS_PER_URL =
  _BOUNDED_READ.boundedReadAttemptsPerEndpoint;

/** Test-only helper: override the inter-retry delay. */
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
 * `boundedReadAttemptsPerEndpoint` times, with a
 * `boundedReadRetryDelayMs` wait before asking the SAME endpoint
 * again — moving to a different one is not a reason to wait.  After
 * spending that budget across every configured RPC it throws
 * `PoolStateUnavailableError`, wrapping the most recent underlying
 * error.  That error is what the dashboard renders as
 * `pool-info-unavailable` and what `bot-cycle.js` turns into a
 * `pollError`, so the budget exists to keep a Manage click answerable
 * rather than hanging.
 *
 * Endpoints come from the app's own failover, not from anything this
 * function keeps: the shared loop in `src/lib/rpc-read-retry.js` asks
 * `sendTx.getCurrentRPC()` for the endpoint and reports failures to
 * `sendTx.failoverToNextRPC()`, so pool state follows selection exactly
 * as every other read does and contributes its outcomes to the same
 * rate.  It supplies only what is specific to it — the work, a bounded
 * budget, and the error raised when that budget is spent.
 *
 * The bound is the one departure from an ordinary read, which retries
 * for ever.  This answer gates a poll cycle and an interactive Manage
 * click, so running out has to produce something an operator can read
 * rather than retrying until some endpoint relents.  Within the budget
 * the retry stays on whichever endpoint selection holds, waiting
 * `boundedReadRetryDelayMs` between tries, which is what gives a blip
 * lasting seconds time to clear.
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
 * **The budget bounds attempts, not wall-clock.**  When every endpoint
 * is down, `failoverToNextRPC` holds the whole JSON-RPC queue for
 * `rpcAllEndpointsDownPauseMS` — an hour by default — and an attempt
 * made during that hold simply waits it out.  So a total outage is the
 * one case where this read offers an operator nothing sooner than the
 * hold allows, budget or no budget.  That is the queue's decision and
 * the right one: exempting the bot's most frequent read would be the
 * hole its rate limit escapes through.
 *
 * @param {object} ethersLib    ethers module.
 * @param {object} opts         Same shape as `_getPoolStateOnce`.
 * @returns {Promise<object>}   Validated pool state.
 * @throws {PoolStateUnavailableError}  All RPCs exhausted.
 */
async function getPoolState(ethersLib, opts) {
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
 * The gas floor for the position manager's heavy calls: the active
 * chain's `contracts.positionManager.mintGasLimit` in chains.json, which
 * `src/lib/config.js` refuses to start without. Shared between
 * `removeLiquidity` (the decrease+collect multicall) and
 * `rebalancer.js#mintPosition`.
 *
 * @returns {bigint}
 */
function _resolveMintGasFloor() {
  return BigInt(config.CHAIN.contracts.positionManager.mintGasLimit);
}

/**
 * Remove all liquidity from a V3 NFT position and collect tokens.
 *
 * Uses balance-diff to determine collected amounts (more robust than
 * parsing logs, which can fail if the ABI event signature doesn't match
 * the on-chain contract exactly).
 */
async function removeLiquidity(
  signer,
  ethersLib,
  { positionManagerAddress, tokenId, liquidity, recipient, token0, token1 },
) {
  const { Contract } = ethersLib;
  const pm = new Contract(positionManagerAddress, PM_ABI, signer);
  const provider = signer.provider;
  const dl = _deadline();
  const t0 = new Contract(token0, ERC20_ABI, provider);
  const t1 = new Contract(token1, ERC20_ABI, provider);

  const [bal0Before, bal1Before] = await Promise.all([
    t0.balanceOf(recipient),
    t1.balanceOf(recipient),
  ]);
  log.info(
    "[rebalance] removeLiq: walletBefore0=%s walletBefore1=%s",
    String(bal0Before),
    String(bal1Before),
  );

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

  const gasCostWei = receiptGasWei(receipt);
  // Determine collected amounts via balance diff (robust across all ABIs)
  const { amount0, amount1 } = await carryingGas(gasCostWei, async () => {
    const [bal0After, bal1After] = await Promise.all([
      t0.balanceOf(recipient),
      t1.balanceOf(recipient),
    ]);
    log.info(
      "[rebalance] removeLiq: walletAfter0=%s walletAfter1=%s",
      String(bal0After),
      String(bal1After),
    );
    const collected0 = bal0After - bal0Before;
    const collected1 = bal1After - bal1Before;
    if (collected0 === 0n && collected1 === 0n) {
      throw new Error(
        "Collected 0 tokens after removing liquidity — aborting to prevent empty mint",
      );
    }
    return { amount0: collected0, amount1: collected1 };
  });
  /*-
   *  The wallet's balance of both coins before the drain goes back with
   *  the amounts collected. A rebalance's Activity Log figure caps the
   *  deposit it sets aside at what the wallet held here, since a deposit
   *  that was not in the wallet before the drain cannot be part of it.
   */
  return {
    amount0,
    amount1,
    txHash: receipt.hash,
    gasCostWei,
    walletBefore: { amount0: bal0Before, amount1: bal1Before },
  };
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
  // Constants
  _MAX_UINT128,
  _DEADLINE_SECONDS,
  _MIN_SWAP_THRESHOLD,
  // Helpers
  _deadline,
  _ensureAllowance,
  _resolveMintGasFloor,
  // Functions
  getPoolState,
  _getPoolStateOnce, // exported for tests
  _setRetryDelayForTests, // exported for tests
  removeLiquidity,
  logSwapNeeded,
};
