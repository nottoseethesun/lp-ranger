/**
 * @file src/lib/compound-collect.js
 * @module compound-collect
 * @description
 * A compound's first transaction: collect the NFT's unclaimed fees into
 * the wallet, and say what it brought in.
 *
 * What it brought in is the amount the collect's own transaction reports
 * collecting (the position manager's `Collect` event), capped at the
 * wallet's rise across it. The rise alone would also count a deposit the
 * owner sent while the collect confirmed, and the compound would then
 * offer that deposit to the position and count it as fees. The cap keeps
 * the rise's one advantage: a token that keeps a fee on each transfer
 * reaches the wallet short of the reported amount.
 *
 * The wallet's two coins before and after the collect go back with the
 * result, for the fee part of the deposit (src/lib/compounded-coins.js).
 * Split from src/lib/compounder.js, which runs the rest of the compound, at
 * the 500-line cap.
 */

"use strict";

const { log } = require("./log");
const sendTx = require("./send-transaction");
const { receiptGasWei } = require("./receipt-gas");
const { carryingGas } = require("./spent-gas");
const { compoundLogCtx: _ctx } = require("./compounder-swap");
const { PM_ABI } = require("./pm-abi");
const { ERC20_ABI, _MAX_UINT128 } = require("./rebalancer-pools");

/**
 * The amounts the collect's own transaction reports collecting for this
 * NFT: the position manager's `Collect` event in its receipt.
 *
 * @param {object} pm  The position manager contract, for its interface.
 * @param {object} receipt  The collect's receipt.
 * @param {{positionManagerAddress: string, tokenId: string}} opts
 * @returns {{amount0: bigint, amount1: bigint}|null}  Null when the
 *   receipt holds no such event.
 */
function _collectReported(pm, receipt, opts) {
  const pmAddr = String(opts.positionManagerAddress).toLowerCase();
  for (const entry of receipt?.logs || []) {
    if (String(entry.address).toLowerCase() !== pmAddr) continue;
    let parsed;
    try {
      parsed = pm.interface.parseLog({
        topics: entry.topics,
        data: entry.data,
      });
    } catch {
      continue;
    }
    if (parsed?.name !== "Collect") continue;
    if (String(parsed.args.tokenId) !== String(opts.tokenId)) continue;
    return { amount0: parsed.args.amount0, amount1: parsed.args.amount1 };
  }
  return null;
}

/**
 * What the collect brought in of one coin: the amount its transaction
 * reports, capped at the wallet's rise across it. A deposit landing while
 * the collect confirmed is in the rise, never in the report; a token that
 * keeps a fee on each transfer lands short of the report, which the rise
 * shows. With no report, the rise alone, never below zero.
 *
 * @param {bigint|undefined} reported  The collect's own figure.
 * @param {bigint} before  The wallet's balance before the collect.
 * @param {bigint} after   The same, after it.
 * @returns {bigint}
 */
function _collectedUnits(reported, before, after) {
  const rise = after > before ? after - before : 0n;
  if (typeof reported !== "bigint") return rise;
  return reported < rise ? reported : rise;
}

/**
 * Collect unclaimed fees from a position to the wallet.
 * Calls decreaseLiquidity(0) to update fee accounting, then collect(MAX).
 * @param {import('ethers').Signer} signer
 * @param {object} ethersLib  ethers module
 * @param {object} opts
 * @param {string} opts.positionManagerAddress
 * @param {string} opts.tokenId
 * @param {string} opts.recipient   Wallet address
 * @param {string} opts.token0      Token0 address
 * @param {string} opts.token1      Token1 address
 * @returns {Promise<{amount0: bigint, amount1: bigint, txHash: string,
 *   gasCostWei: bigint, walletBefore: {raw0: bigint, raw1: bigint},
 *   walletAfter: {raw0: bigint, raw1: bigint}}>}  What the collect
 *   brought in (`_collectedUnits`), and the wallet's two coins before and
 *   after it, which tell the fees the deposit puts back from the wallet's
 *   other coins (src/lib/compounded-coins.js).
 */
async function collectFees(signer, ethersLib, opts) {
  const { Contract } = ethersLib;
  const pm = new Contract(opts.positionManagerAddress, PM_ABI, signer);
  const provider = signer.provider;

  const t0 = new Contract(opts.token0, ERC20_ABI, provider);
  const t1 = new Contract(opts.token1, ERC20_ABI, provider);
  const [bal0Before, bal1Before] = await Promise.all([
    t0.balanceOf(opts.recipient),
    t1.balanceOf(opts.recipient),
  ]);
  const cx = _ctx(opts);
  log.info(
    "[compound] %s collectFees: walletBefore0=%s walletBefore1=%s",
    cx,
    String(bal0Before),
    String(bal1Before),
  );

  /*- collect() on the NonfungiblePositionManager internally calls
      pool.burn(0) to update fee accounting before collecting.  Routed
      through send-transaction.js so estimateGas, broadcast, and the
      speed-up/cancel pipeline all benefit from RPC failover. */
  const { receipt } = await sendTx.sendTransaction({
    populate: () =>
      pm.collect.populateTransaction({
        tokenId: opts.tokenId,
        recipient: opts.recipient,
        amount0Max: _MAX_UINT128,
        amount1Max: _MAX_UINT128,
      }),
    signer,
    label: "[compound] " + cx + " collect",
  });

  const gasCostWei = receiptGasWei(receipt);
  /*-
   *  The collect has confirmed and been paid for: a failure reading what
   *  it collected carries its gas (src/lib/spent-gas.js).
   */
  const [bal0After, bal1After] = await carryingGas(gasCostWei, () =>
    Promise.all([t0.balanceOf(opts.recipient), t1.balanceOf(opts.recipient)]),
  );
  const reported = _collectReported(pm, receipt, opts);
  const amount0 = _collectedUnits(reported?.amount0, bal0Before, bal0After);
  const amount1 = _collectedUnits(reported?.amount1, bal1Before, bal1After);
  const s0 = opts.token0Symbol || "Token0";
  const s1 = opts.token1Symbol || "Token1";
  log.info(
    "[compound] %s collectFees: %s=%s %s=%s (collect reported %s, wallet rose %s / %s)",
    cx,
    s0,
    String(amount0),
    s1,
    String(amount1),
    reported === null
      ? "nothing"
      : String(reported.amount0) + " / " + String(reported.amount1),
    String(bal0After - bal0Before),
    String(bal1After - bal1Before),
  );

  return {
    amount0,
    amount1,
    txHash: receipt.hash,
    gasCostWei,
    walletBefore: { raw0: bal0Before, raw1: bal1Before },
    walletAfter: { raw0: bal0After, raw1: bal1After },
  };
}

module.exports = { collectFees };
