/**
 * @file src/get-logs-chunked.js
 * @module getLogsChunked
 * @description
 * The one place block ranges are split for `eth_getLogs` / `queryFilter`.
 *
 * RPC endpoints cap how wide a single log query may be and reject
 * anything wider — `rpc-pulsechain.g4mm4.io` answers a too-wide query
 * with JSON-RPC `-32602`, "eth_getLogs is limited to a 10000 block
 * range".  A caller that hands over a five-year span therefore gets an
 * error rather than logs, and several callers used to swallow that
 * error and report "nothing found", which is far worse than failing.
 *
 * This module removes block arithmetic from every caller: hand it a
 * range and a `query` function, and it walks the range in windows no
 * wider than `getLogsChunkSize` (`bot-config-defaults.json`).
 *
 * **Why `query` is a callback rather than a filter object.**  Callers
 * differ in shape — some use `provider.getLogs({address, topics})`,
 * some `contract.queryFilter(filter, from, to)`, and several fire two
 * to four of those per window in parallel.  A callback expresses all of
 * that without this module knowing anything about filters, so it stays
 * a windowing loop and nothing more.
 *
 * **Errors propagate by default.**  A chunk that fails fails the scan.
 * `bestEffort: true` is available for callers that genuinely prefer
 * partial data, but it must be an explicit choice at the call site —
 * silently returning partial results is how a range-cap rejection used
 * to masquerade as an empty wallet.
 *
 * Pacing is NOT handled here.  Every request is already spaced by the
 * global queue in `src/rpc-request-manager.js`, which sees individual
 * requests and so can bound the rate that a per-chunk delay never
 * could — a window firing four parallel queries is four requests, not
 * one.
 */

"use strict";

const { log } = require("./log");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const {
  isBlockRangeCapError,
  extractBlockRangeCap,
} = require("./rpc-error-classifier");

/*- Read once at load, like the pacing interval.  Operators change this
 *  only when an endpoint imposes a stricter cap, and a restart is a
 *  reasonable price for that. */
const _DEFAULT_CHUNK_SIZE = readBotConfigDefaults().getLogsChunkSize;

/**
 * Throw if an AbortSignal is aborted.  Checked once per window so a
 * cancelled scan stops within one RPC round-trip.
 * @param {AbortSignal} [signal]
 * @param {string} where  Short label for the log message.
 */
function throwIfAborted(signal, where) {
  if (signal && signal.aborted) {
    log.info("[scan] %s aborted via AbortSignal", where);
    const err = new Error("Scan aborted");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Split an inclusive block range into windows no wider than `chunkSize`.
 *
 * Pure and synchronous, so the arithmetic that every scan depends on can
 * be tested without a provider.  Returns `[]` when the range is empty or
 * inverted, which callers rely on to no-op rather than error.
 *
 * @param {number} fromBlock   First block, inclusive.
 * @param {number} toBlock     Last block, inclusive.
 * @param {number} chunkSize   Maximum blocks per window.
 * @param {string} [direction] `"asc"` (default) oldest-first, or
 *   `"desc"` newest-first.  Each window is still `[low, high]`; only
 *   the order they are visited changes.
 * @returns {Array<{from: number, to: number}>}
 */
function chunkRanges(fromBlock, toBlock, chunkSize, direction = "asc") {
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) return [];
  if (fromBlock > toBlock) return [];
  const size = Math.max(1, Math.floor(chunkSize));
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += size) {
    out.push({ from: start, to: Math.min(start + size - 1, toBlock) });
  }
  return direction === "desc" ? out.reverse() : out;
}

/**
 * Resolve a `toBlock` that may be the string `"latest"`.
 *
 * Chunking cannot begin without a concrete upper bound, and several
 * callers pass `"latest"`.  Resolved once per scan rather than per
 * window, so the range cannot drift mid-scan.
 * @param {object} provider  Anything with `getBlockNumber()`.
 * @param {number|string} toBlock
 * @returns {Promise<number>}
 */
async function resolveToBlock(provider, toBlock) {
  if (typeof toBlock === "number" && Number.isFinite(toBlock)) return toBlock;
  if (toBlock !== undefined && toBlock !== null && toBlock !== "latest") {
    const n = Number(toBlock);
    if (Number.isFinite(n)) return n;
  }
  if (!provider || typeof provider.getBlockNumber !== "function") {
    throw new Error(
      "[scan] chunked scan needs a numeric toBlock or a provider with getBlockNumber()",
    );
  }
  return await provider.getBlockNumber();
}

/*- Progress logging cadence.  One line per window would drown the
 *  terminal on a multi-thousand-chunk scan; every 50 matches what the
 *  event scanner has always done. */
const _LOG_EVERY = 50;

/**
 * Turn a range-cap rejection into something a person can act on.
 *
 * The raw ethers error for this is a multi-line `could not coalesce
 * error` dump carrying the whole JSON-RPC payload — it reached the
 * dashboard's Activity Log verbatim and told the operator nothing.
 * This replaces it with the three facts that matter: how wide the
 * query was, what the endpoint allows, and which setting to change.
 *
 * Thrown even in `bestEffort` mode.  Best-effort exists for a flaky
 * endpoint, not for a misconfiguration: every window would fail the
 * same way, so carrying on would just produce an empty result with a
 * warning buried somewhere above it.
 * @param {*} err   The original endpoint error.
 * @param {{from: number, to: number}} win
 * @returns {Error}
 */
function _capError(err, win) {
  const span = win.to - win.from + 1;
  const cap = extractBlockRangeCap(err);
  const capText = cap === null ? "a narrower range" : `${cap} blocks`;
  const e = new Error(
    `RPC rejected a ${span}-block query (endpoint allows ${capText}). ` +
      "Lower getLogsChunkSize in bot-config-defaults.json.",
  );
  e.name = "BlockRangeCapError";
  e.cause = err;
  return e;
}

/**
 * Run one window's query, honouring the best-effort flag.
 * @param {object} opts   The scan options.
 * @param {object} win    `{from, to}`.
 * @param {string} label  Log label.
 * @returns {Promise<*>}  The query result, or `null` when a best-effort
 *   chunk failed.
 */
async function _runWindow(opts, win, label) {
  try {
    return await opts.query(win.from, win.to);
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    if (isBlockRangeCapError(err)) throw _capError(err, win);
    if (!opts.bestEffort) throw err;
    log.warn(
      "[scan] %s: chunk %d-%d failed (continuing): %s",
      label,
      win.from,
      win.to,
      err.message,
    );
    /*- Tell the caller WHICH window was skipped.  Best-effort means the
     *  result is incomplete, and a caller that persists a "scanned up
     *  to here" marker needs to know where the hole starts — otherwise
     *  it records ground it never covered and never comes back for it. */
    if (opts.onWindowError) opts.onWindowError(err, win.from, win.to);
    return null;
  }
}

/**
 * Walk a block range in capped windows, collecting results.
 *
 * @param {object} opts
 * @param {Function} opts.query      `(fromBlock, toBlock) => Promise<*>`.
 *   Called once per window.  Whatever it returns is passed to
 *   `onChunk`; array results are concatenated into the return value.
 * @param {number} opts.fromBlock    First block, inclusive.
 * @param {number|string} opts.toBlock  Last block, or `"latest"`.
 * @param {object} [opts.provider]   Needed only to resolve `"latest"`.
 * @param {number} [opts.chunkSize]  Defaults to `getLogsChunkSize`.
 * @param {string} [opts.direction]  `"asc"` (default) or `"desc"`.
 * @param {Function} [opts.onChunk]  `(result, from, to) => boolean`.
 *   Return `true` to stop early — used by lookups that want the first
 *   match rather than every match.
 * @param {Function} [opts.onProgress] `(done, total)` after each window.
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.label]      Short label for log lines.
 * @param {boolean} [opts.bestEffort] Continue past a failed window
 *   instead of throwing.  Default `false`.
 * @param {Function} [opts.onWindowError] `(err, from, to)` for each
 *   window skipped under `bestEffort`.  Callers that persist scan
 *   progress must use this to avoid recording a range they did not
 *   actually read.
 * @returns {Promise<Array>}  Concatenated array results, in visit order.
 */
async function scanChunked(opts) {
  const label = opts.label || "scan";
  /*- Explicit validity check rather than `||` or `??`.  `||` would
   *  silently swallow a deliberate 0; `??` would pass it through, and
   *  chunkRanges floors at 1, turning a typo into one-block windows and
   *  millions of requests.  Anything that is not a positive finite
   *  number is not a chunk size. */
  const chunkSize =
    typeof opts.chunkSize === "number" &&
    Number.isFinite(opts.chunkSize) &&
    opts.chunkSize > 0
      ? opts.chunkSize
      : _DEFAULT_CHUNK_SIZE;
  const toBlock = await resolveToBlock(opts.provider, opts.toBlock);
  const windows = chunkRanges(
    opts.fromBlock,
    toBlock,
    chunkSize,
    opts.direction,
  );

  const collected = [];
  let done = 0;
  for (const win of windows) {
    throwIfAborted(opts.signal, label);
    const result = await _runWindow(opts, win, label);
    done++;
    if (result !== null && result !== undefined) {
      if (Array.isArray(result)) collected.push(...result);
      if (opts.onChunk && opts.onChunk(result, win.from, win.to) === true) {
        if (opts.onProgress) opts.onProgress(done, windows.length);
        return collected;
      }
    }
    if (done % _LOG_EVERY === 0 || done === windows.length) {
      log.info(
        "[scan] %s: %d/%d chunks scanned (%d results)",
        label,
        done,
        windows.length,
        collected.length,
      );
    }
    if (opts.onProgress) opts.onProgress(done, windows.length);
  }
  return collected;
}

module.exports = {
  scanChunked,
  chunkRanges,
  resolveToBlock,
  throwIfAborted,
  _DEFAULT_CHUNK_SIZE,
};
