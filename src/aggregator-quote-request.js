/**
 * @file src/aggregator-quote-request.js
 * @module aggregatorQuoteRequest
 * @description
 * One request for an aggregator quote, under one time limit, with the
 * aggregator's own reasons carried on a refusal.
 *
 * Split from `src/rebalancer-aggregator.js` at the 500-line cap. That
 * module builds the quote url and decides what a quote may lead to; this
 * one only asks and reads the answer. A quote that fails here throws. On
 * a first quote nothing has been sent yet, so `swapIfNeeded` swaps
 * through the V3 router in the position's own pool instead; a re-quote
 * can come after an approval was mined, or after a swap reverted or was
 * cancelled.
 */

"use strict";

const config = require("./config");

/**
 * Build the error for a quote the aggregator refused, carrying whatever
 * reasons its body gives: the 0x v1 `reason` or `code`, each validation
 * error, and any balance or allowance shortfall it reports.
 *
 * @param {Response} res  The answer, which was not a 2xx.
 * @returns {Promise<Error>} The error to throw.
 */
async function _quoteHttpError(res) {
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
    body = [reason, valErrs, balIssue, allowIssue].filter(Boolean).join(" | ");
  } catch {
    /* response wasn't JSON */
  }
  return new Error(
    "Aggregator API: HTTP " + res.status + (body ? " — " + body : ""),
  );
}

/**
 * Ask the aggregator for a quote and read its answer, all under one time
 * limit.
 *
 * The limit is `config.AGGREGATOR_QUOTE_TIMEOUT_MS`, read per call so a
 * test can shorten it, and it covers the whole exchange. A server that
 * never answers ends here, and so does one that starts an answer and
 * then stalls partway through the body. A quote that runs out of time
 * is a failed quote like any other, and throws.
 *
 * @param {string} url  The full quote url.
 * @returns {Promise<object>} The parsed quote.
 * @throws {Error} On an answer that is not a 2xx, carrying the reasons the
 *   aggregator gave, or when no answer arrives within the limit.
 */
async function requestQuote(url) {
  const limitMs = config.AGGREGATOR_QUOTE_TIMEOUT_MS;
  const signal = AbortSignal.timeout(limitMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) throw await _quoteHttpError(res);
    return await res.json();
  } catch (err) {
    if (err?.name !== "TimeoutError") throw err;
    throw new Error(`Aggregator API: no answer within ${limitMs / 1000} s`, {
      cause: err,
    });
  }
}

module.exports = { requestQuote };
