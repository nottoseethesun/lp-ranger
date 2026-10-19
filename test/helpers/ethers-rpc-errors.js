"use strict";

/**
 * @file test/helpers/ethers-rpc-errors.js
 * @description The errors ethers raises for an endpoint's error answers,
 *   built by ethers' own code rather than by hand.
 *
 *   A hand-built error carries whatever fields its author thought ethers
 *   sets, and a test that passes against it says nothing about what the
 *   app does with the real one. These go through
 *   `JsonRpcProvider.prototype.getRpcError`, the method a provider calls
 *   to turn a JSON-RPC error answer into the error it throws, so each
 *   carries exactly the fields ethers gives that answer. The method reads
 *   only its two arguments, so no provider is needed.
 */

const { AbiCoder, JsonRpcProvider, concat } = require("ethers");

/** Turn a JSON-RPC error answer to `method` into ethers' error. */
function _rpcError(method, params, error) {
  const payload = { method, params, id: 1, jsonrpc: "2.0" };
  return JsonRpcProvider.prototype.getRpcError(payload, { error });
}

/** A contract read, as the error's request names it. */
const _CALL = { to: "0x" + "c0".repeat(20), data: "0x6352211e" };

/**
 * The error a contract read raises when the contract itself reverts with
 * `reason`, as an ERC-721 does when asked who owns an NFT that does not
 * exist.
 * @param {string} reason
 * @returns {Error}  A `CALL_EXCEPTION` carrying the revert's data.
 */
function contractReverted(reason) {
  const data = concat([
    "0x08c379a0",
    AbiCoder.defaultAbiCoder().encode(["string"], [reason]),
  ]);
  return _rpcError("eth_call", [_CALL, "latest"], {
    code: 3,
    message: `execution reverted: ${reason}`,
    data,
  });
}

/**
 * The error a contract read raises when the endpoint answers with an
 * error of its own, such as a rate limit, without running the call.
 * @param {string} message  The endpoint's message.
 * @returns {Error}  A `CALL_EXCEPTION` with no revert data.
 */
function endpointFailedRead(message) {
  return _rpcError("eth_call", [_CALL, "latest"], {
    code: -32005,
    message,
  });
}

/**
 * The error a raw submission raises when the endpoint refuses it as
 * "nonce too low": a transaction has already been mined at its nonce.
 * @param {string} signed  The signed transaction submitted, as hex.
 * @returns {Error}  A `NONCE_EXPIRED` carrying the submission's signed
 *   bytes as `transaction`, and no `payload`.
 */
function nonceTooLow(signed) {
  return _rpcError("eth_sendRawTransaction", [signed], {
    code: -32000,
    message: "nonce too low",
  });
}

module.exports = { contractReverted, endpointFailedRead, nonceTooLow };
