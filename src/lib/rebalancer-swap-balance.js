/**
 * @file src/lib/rebalancer-swap-balance.js
 * @module rebalancer-swap-balance
 * @description
 * What a swap delivered, read as the rise in the recipient's balance of
 * the token bought. Split from `src/lib/rebalancer-swap.js` at the 500-line
 * cap; that module hands `balanceDiff` to both swap routes, the
 * aggregator and the V3 router, which run their send and confirmation
 * inside it.
 *
 * The balance is read once before the swap and once after it. The read
 * after it is the one that matters most, because by then the swap has
 * happened and cannot be undone: a failure there that let `swapIfNeeded`
 * fall back to the other route would swap the same balance twice. So
 * that read asks every endpoint before it gives up, and an error it
 * gives up with is marked `swapLanded`, which `swapIfNeeded` reads as
 * "no fallback".
 *
 * The rise in the balance counts any coins that reached the wallet while
 * the swap ran, a deposit the owner made included. So the swap's own
 * exchange is also read from its transaction's receipt: what the wallet
 * sent of the token sold, and what it was paid of the token bought
 * (`exchange`). A compound counts its fees by it, so that a deposit
 * landing during its swap never counts as fees (src/lib/compounder.js).
 */

"use strict";

const { ERC20_ABI } = require("./rebalancer-pools");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const { spentGasOf, carryingGas } = require("./spent-gas");
const sendTx = require("./send-transaction");
const { noteRpcResult } = require("./rpc-out-of-service");
const { retryRead } = require("./rpc-read-retry");

/*-
 *  The budget of the balance read after a swap has landed, shared with
 *  pool state and the re-open check's wallet read:
 *  `boundedReadAttemptsPerEndpoint` and `boundedReadRetryDelayMs` in
 *  bot-config-defaults.json. The delay is `let`, set through
 *  `_setLandedReadDelayForTests`, so unit tests can drop it to zero.
 */
const _BOUNDED_READ = readBotConfigDefaults();
const _ATTEMPTS_PER_URL = _BOUNDED_READ.boundedReadAttemptsPerEndpoint;
let _RETRY_DELAY_MS = _BOUNDED_READ.boundedReadRetryDelayMs;

/** Test-only helper: override the wait before one endpoint is asked again. */
function _setLandedReadDelayForTests(ms) {
  _RETRY_DELAY_MS = ms;
}

/** An ERC-20 `Transfer(address,address,uint256)` event's first topic. */
const _TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The address an indexed topic holds, lower-cased. */
function _topicAddress(topic) {
  return ("0x" + String(topic).slice(26)).toLowerCase();
}

/** A receipt log read as an ERC-20 transfer, or null when it is none. */
function _transferIn(l) {
  if (l?.topics?.[0] !== _TRANSFER_TOPIC || l.topics.length < 3) return null;
  if (typeof l.data !== "string" || l.data.length < 66) return null;
  return {
    coin: String(l.address).toLowerCase(),
    from: _topicAddress(l.topics[1]),
    to: _topicAddress(l.topics[2]),
    value: BigInt(l.data.slice(0, 66)),
  };
}

/** What one transfer moves of a coin into the wallet, out of it negative. */
function _intoWallet(t, coin, me) {
  if (t.coin !== coin) return 0n;
  return (t.to === me ? t.value : 0n) - (t.from === me ? t.value : 0n);
}

/**
 * What one swap transaction moved between the wallet and the market, read
 * from its own receipt: the token sold the wallet sent, and the token
 * bought it was paid, each net of any of it coming back to where it came
 * from. A deposit the owner made meanwhile is a transaction of its own,
 * so it is in neither.
 *
 * @param {object|null|undefined} receipt  The swap's receipt.
 * @param {string} tokenIn    Address of the token sold.
 * @param {string} tokenOut   Address of the token bought.
 * @param {string} recipient  The wallet.
 * @returns {{sent: bigint, received: bigint}|null}  Null with no receipt
 *   to read.
 */
function exchangeInTx(receipt, tokenIn, tokenOut, recipient) {
  if (!Array.isArray(receipt?.logs)) return null;
  const me = String(recipient).toLowerCase();
  const sold = String(tokenIn).toLowerCase();
  const bought = String(tokenOut).toLowerCase();
  let sent = 0n;
  let received = 0n;
  for (const l of receipt.logs) {
    const t = _transferIn(l);
    if (t === null) continue;
    sent -= _intoWallet(t, sold, me);
    received += _intoWallet(t, bought, me);
  }
  return {
    sent: sent > 0n ? sent : 0n,
    received: received > 0n ? received : 0n,
  };
}

/**
 * The recipient's balance of the token bought, read once the swap has
 * landed.
 *
 * Asked as pool state is asked: each endpoint in service up to
 * `boundedReadAttemptsPerEndpoint` times, any error counting as the
 * endpoint's, every outcome reported to the app's failover so that
 * selection moves off an endpoint whose failure rate says it should.
 * An ordinary read fails over only when an endpoint cannot be reached,
 * and fails at once when one answers with an error; this read asks the
 * others either way, because the swap behind it cannot be undone. Only
 * once that budget is spent does the last error come back, for
 * `balanceDiff` to mark `swapLanded`.
 *
 * @param {object} ethersLib  ethers, for the token contract.
 * @param {string} tokenOut   Address of the token bought.
 * @param {string} recipient  Wallet the bought token is paid to.
 * @returns {Promise<bigint>}
 */
function _landedBalance(ethersLib, tokenOut, recipient) {
  return retryRead({
    tag: "swap",
    label: `balanceOf(${tokenOut}) after the swap`,
    run: (provider) =>
      new ethersLib.Contract(tokenOut, ERC20_ABI, provider).balanceOf(
        recipient,
      ),
    /*-
     *  The loop needs a failure to enter on, and nothing has been asked
     *  yet; only `isFailoverable` reads it.
     */
    err: new Error("balance after the swap not read yet"),
    isFailoverable: () => true,
    failover: sendTx.failoverToNextRPC,
    current: sendTx.getCurrentRPC,
    urlOf: sendTx.urlOf,
    note: (provider, ok) => noteRpcResult(sendTx.urlOf(provider), ok),
    /*-
     *  Floored at one, as pool state's is, so a layer nobody
     *  initialised throws that fault by name from `current()`.
     */
    maxAttempts: Math.max(1, sendTx.endpointCount() * _ATTEMPTS_PER_URL),
    delayMs: _RETRY_DELAY_MS,
  });
}

/**
 * Run a swap and report what it delivered, as the rise in the recipient's
 * balance of the token bought.
 *
 * The balance is read once before the swap and once after it, so the
 * figure is what reached the wallet. A balance that did not rise reports
 * zero rather than a negative amount. The aggregator swap and the V3
 * router swap are handed this function and run their send and
 * confirmation inside it; a swap that throws passes its error through
 * unchanged, with whatever gas it carries. The read after the swap is
 * `_landedBalance`, which asks every endpoint before it gives up. One
 * that fails even so carries the swap's gas instead, and is marked
 * `swapLanded`: the swap happened, so `swapIfNeeded` must not send
 * another of the same balance through a fallback route.
 *
 * The swap's result also carries `exchange`, read from the receipt the
 * swap hands back (`exchangeInTx`), with what it was paid capped at the
 * balance gained; the receipt itself goes no further. With no receipt,
 * or no token sold named, `exchange` is null.
 *
 * @param {object} ethersLib  ethers, for the token contract.
 * @param {string} tokenOut   Address of the token bought.
 * @param {string} recipient  Wallet the bought token is paid to.
 * @param {object} prov       Provider for the read before the swap.
 * @param {() => Promise<object>} fn  Sends the swap and resolves to its
 *   result, with the swap's `receipt`.
 * @param {string} [tokenIn]  Address of the token sold.
 * @returns {Promise<object>} The swap's result, with `amountOut` set to
 *   the balance gained.
 */
async function balanceDiff(ethersLib, tokenOut, recipient, prov, fn, tokenIn) {
  const outC = new ethersLib.Contract(tokenOut, ERC20_ABI, prov);
  const before = await outC.balanceOf(recipient);
  const result = await fn();
  let diff;
  try {
    diff = await carryingGas(
      spentGasOf(result),
      async () =>
        (await _landedBalance(ethersLib, tokenOut, recipient)) - before,
    );
  } catch (err) {
    err.swapLanded = true;
    throw err;
  }
  const { receipt, ...swap } = result;
  const amountOut = diff > 0n ? diff : 0n;
  const inTx =
    typeof tokenIn === "string"
      ? exchangeInTx(receipt, tokenIn, tokenOut, recipient)
      : null;
  const exchange =
    inTx === null
      ? null
      : {
          sent: inTx.sent,
          received: inTx.received < amountOut ? inTx.received : amountOut,
        };
  return { ...swap, amountOut, exchange };
}

module.exports = { balanceDiff, exchangeInTx, _setLandedReadDelayForTests };
