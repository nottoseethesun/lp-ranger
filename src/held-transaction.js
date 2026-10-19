"use strict";

/**
 * @file src/held-transaction.js
 * @module held-transaction
 * @description
 * Recover a transaction an endpoint says it already holds.
 *
 * When the bot submits a transaction and the endpoint's reply is lost, it
 * submits the same transaction again. An endpoint that did take the first
 * copy answers the second with "already known": it is holding exactly this
 * transaction, waiting to be mined. That is not a failure. The transaction
 * is in the endpoint's queue and may still confirm, so the bot has to wait
 * on it the way it waits on any transaction it submits, and speed it up and
 * cancel it on the usual schedule.
 *
 * To wait on it the bot needs it as an object it can ask for a receipt,
 * which the endpoint's answer does not supply. The request the bot sent
 * does: ethers carries it on the error, and its one parameter is the
 * signed transaction itself. Signed bytes identify a transaction exactly,
 * so the transaction rebuilt from them is the very one the endpoint holds.
 *
 * It is rebuilt the way ethers builds one for a fresh submission, set up
 * to notice a replacement from the block current when it is recovered. A
 * transaction waited on without that would never notice another
 * transaction taking its nonce, and the wait could last forever.
 *
 * The same request answers a second question, about a resubmission the
 * endpoint refuses as "nonce too low". The nonce is taken, and one thing
 * that can have taken it is the first copy of this very transaction,
 * accepted though its reply was lost and since mined. Signing is
 * deterministic, so the refused copy's bytes, and its hash, are that
 * first copy's: the chain can be asked about the hash, and a cancel the
 * bot sent itself is then not mistaken for someone else's transaction.
 */

const { Transaction, TransactionResponse } = require("ethers");

/**
 * The signed transaction an "already known" error's request carried, or
 * null when the error does not carry one.
 *
 * @param {Error} err  The error ethers raised for the endpoint's answer.
 * @returns {import('ethers').Transaction|null}
 */
function _signedTransaction(err) {
  const payload = err.payload;
  if (payload === undefined || payload === null) return null;
  if (payload.method !== "eth_sendRawTransaction") return null;
  const raw = Array.isArray(payload.params) ? payload.params[0] : undefined;
  if (typeof raw !== "string") return null;
  try {
    return Transaction.from(raw);
  } catch {
    return null;
  }
}

/**
 * Rebuild the transaction an endpoint answered "already known" for, ready
 * to be waited on.
 *
 * @param {Error} err  The error ethers raised for the endpoint's answer.
 * @param {{wait: object, read: object}} providers  `wait` is the provider
 *   the transaction is waited on through, as a fresh submission is through
 *   the endpoint that took it; `read` is the one the current block is read
 *   from, which starts the watch for a replacement.
 * @returns {Promise<import('ethers').TransactionResponse|null>} The
 *   transaction, or null when it cannot be recovered: a provider is
 *   missing, or the error carries no signed transaction.
 */
async function heldTransaction(err, providers) {
  const wait = providers?.wait;
  const read = providers?.read;
  if (wait === undefined || wait === null) return null;
  if (read === undefined || read === null) return null;
  const tx = _signedTransaction(err);
  if (tx === null) return null;
  const startBlock = await read.getBlockNumber();
  const response = new TransactionResponse(
    {
      blockNumber: null,
      blockHash: null,
      hash: tx.hash,
      index: 0,
      type: tx.type,
      from: tx.from,
      to: tx.to,
      gasLimit: tx.gasLimit,
      nonce: tx.nonce,
      data: tx.data,
      value: tx.value,
      gasPrice: tx.gasPrice,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      maxFeePerGas: tx.maxFeePerGas,
      maxFeePerBlobGas: tx.maxFeePerBlobGas,
      chainId: tx.chainId,
      signature: tx.signature,
      accessList: tx.accessList,
      blobVersionedHashes: tx.blobVersionedHashes,
      authorizationList: tx.authorizationList,
    },
    wait,
  );
  return response.replaceableTransaction(startBlock);
}

/**
 * The hash of the signed transaction an error's request carried, or null
 * when it carries none. For a refused resubmission, it is the hash of the
 * copy that may already have mined; see the file header.
 * @param {Error} err  The error ethers raised for the endpoint's answer.
 * @returns {string|null}
 */
function signedTransactionHash(err) {
  const tx = _signedTransaction(err);
  return tx === null ? null : tx.hash;
}

module.exports = { heldTransaction, signedTransactionHash };
