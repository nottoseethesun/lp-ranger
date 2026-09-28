"use strict";

/**
 * @file util/diagnostic/check-rpc-health.js
 * @description
 * Ask one RPC endpoint whether it is healthy, and print the answer as a
 * table of seven checks: that it responds at all, that it is PulseChain,
 * that it has a latest block and can describe it, that it is not still
 * syncing, that the chain is advancing, and that its transaction pool
 * answers.
 *
 * Defaults to `https://rpc-pulsechain.g4mm4.io`, the endpoint the app
 * prefers, and `--rpc-endpoint <url>` points it at any other. Each of
 * the app's endpoints is a separate host, so a health question is always
 * about one of them — which is why the endpoint under test is printed
 * above the table rather than left to be inferred.
 *
 * **It imports nothing from `src/`** — only `_helpers`, which is itself
 * dependency-free. That is deliberate and worth keeping. Reaching for
 * `config.RPC_URLS` to get the default would load the app's config,
 * which opens the log file and reads operator settings, so the tool
 * could no longer be run against a live install without disturbing it.
 * As written it makes plain HTTP requests and touches nothing on disk,
 * so it is safe to run while Production is up — which is the moment its
 * answer is wanted. The cost is that the default endpoint is a second
 * literal beside the one in `chains.json`, paid knowingly.
 *
 * Exit status is 0 when every check passes and 1 otherwise, so it can
 * gate a shell script.
 *
 * Usage:
 *   node util/diagnostic/check-rpc-health.js
 *   node util/diagnostic/check-rpc-health.js --rpc-endpoint https://rpc.pulsechain.com
 */

const { Command, InvalidArgumentError } = require("commander");
const { sleep } = require("./_helpers");

/** The endpoint used when `--rpc-endpoint` is not given: the app's first. */
const DEFAULT_RPC = "https://rpc-pulsechain.g4mm4.io";

const EXPECTED_CHAIN_ID = "0x171"; // 369
const TIMEOUT_MS = 10000;

/**
 * Accept an `--rpc-endpoint` value, or reject it naming the flag.
 *
 * Commander calls this while parsing, so a bad value is refused before
 * any request is made and the message says which option was wrong —
 * where letting it through would surface later as a `fetch` failure
 * that never mentions the flag.
 *
 * @param {string} value  The raw option value.
 * @returns {string}  The same value, once it is a usable http(s) URL.
 * @throws {InvalidArgumentError} When it is not.
 */
function parseEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidArgumentError(`not a URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidArgumentError(
      `must be http or https, got ${parsed.protocol}`,
    );
  }
  return value;
}

/**
 * Describe the command line, so Commander both parses it and renders
 * `--help` from the same declaration.
 *
 * Building this fresh per call rather than holding one module-level
 * program keeps a test free to parse several argument lists without
 * options accumulating between them.
 *
 * @returns {Command}  Configured, not yet parsed.
 */
function buildProgram() {
  return new Command()
    .name("check-rpc-health")
    .description(
      "Ask one RPC endpoint whether it is serving.\n\n" +
        "Seven checks, each timed: reachability, chain 369, latest block,\n" +
        "block detail, sync state, block progression (after a 3 s wait),\n" +
        "and transaction pool. A failing check is recorded and the run\n" +
        "continues, since which parts still work is the useful part.",
    )
    .option(
      "--rpc-endpoint <url>",
      "endpoint to probe; one per run, because a health answer applies " +
        "to one host only",
      parseEndpoint,
      DEFAULT_RPC,
    )
    .addHelpText(
      "after",
      "\nThe endpoint and the UTC start time print above the table, so a " +
        "run\ncan be lined up against the app's log, which also timestamps " +
        "in UTC.\n\nExit codes:\n  0  all seven checks passed\n" +
        "  1  any check failed, or the arguments were bad\n",
    );
}

/**
 * Send one JSON-RPC call to `endpoint` and return its result and how
 * long it took.
 *
 * @param {string} endpoint  The RPC URL to call.
 * @param {string} method    JSON-RPC method name.
 * @param {unknown[]} [params]  Method parameters.
 * @returns {Promise<{result: *, latencyMs: number}>}
 * @throws {Error} On a transport failure, a non-JSON body, an HTTP
 *   error status, or a JSON-RPC `error` member.
 */
async function rpc(endpoint, method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;
    const text = await response.text();

    let body;

    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `HTTP ${response.status}: non-JSON response: ${text.slice(0, 100)}`,
      );
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (body.error) {
      throw new Error(`${body.error.code}: ${body.error.message}`);
    }

    return {
      result: body.result,
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a 0x-prefixed hex string to a number. */
function hexToNumber(value) {
  return Number.parseInt(value, 16);
}

/**
 * Render the moment a run began, UTC first.
 *
 * UTC is what makes a run comparable with anything else: the app's own
 * log timestamps every line in UTC, so a probe printed this way can be
 * lined up against the failure it was run to explain. Local time
 * follows in parentheses with its zone, the same pairing the dashboard
 * uses, so the reader does not have to convert to know whether this was
 * during their afternoon.
 *
 * @param {Date} date  When the run started.
 * @returns {string}  e.g. `2026-09-28 19:34:25 UTC (9/28/2026, 2:34:25 PM CDT)`
 */
function fmtStart(date) {
  const utc = `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
  const local = date.toLocaleString(undefined, { timeZoneName: "short" });
  return `${utc} (${local})`;
}

/** Render a block's hex timestamp as its age in seconds. */
function blockAge(timestampHex) {
  const timestamp = hexToNumber(timestampHex);
  const age = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  return `${age}s old`;
}

/**
 * Run every check against `endpoint`, in order, collecting one row per
 * check rather than stopping at the first failure — a run that fails
 * early is less informative than one that says which parts still work.
 *
 * @param {string} endpoint  The RPC URL to probe.
 * @returns {Promise<object[]>}  One `{name, ok, latencyMs, …}` per check.
 */
async function runChecks(endpoint) {
  const checks = [];
  const call = (method, params) => rpc(endpoint, method, params);

  async function check(name, fn) {
    const started = Date.now();

    try {
      const result = await fn();

      checks.push({
        name,
        ok: true,
        latencyMs: Date.now() - started,
        result,
      });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        latencyMs: Date.now() - started,
        error: error.message,
      });
    }
  }

  await check("RPC reachable", async () => {
    const response = await call("web3_clientVersion");
    return response.result;
  });

  await check("Correct PulseChain network", async () => {
    const [chainId, networkId] = await Promise.all([
      call("eth_chainId"),
      call("net_version"),
    ]);

    if (chainId.result.toLowerCase() !== EXPECTED_CHAIN_ID) {
      throw new Error(`Expected chain 369, got ${chainId.result}`);
    }

    if (networkId.result !== "369") {
      throw new Error(`Expected network 369, got ${networkId.result}`);
    }

    return {
      chainId: hexToNumber(chainId.result),
      networkId: networkId.result,
    };
  });

  let firstBlock;

  await check("Latest block available", async () => {
    const response = await call("eth_blockNumber");
    firstBlock = hexToNumber(response.result);

    if (!Number.isInteger(firstBlock)) {
      throw new Error(`Invalid block number: ${response.result}`);
    }

    return firstBlock;
  });

  await check("Latest block details", async () => {
    const response = await call("eth_getBlockByNumber", [
      `0x${firstBlock.toString(16)}`,
      false,
    ]);

    const block = response.result;

    if (!block) {
      throw new Error("No block data returned");
    }

    if (hexToNumber(block.number) !== firstBlock) {
      throw new Error("Block number mismatch");
    }

    return {
      number: firstBlock,
      hash: block.hash,
      age: blockAge(block.timestamp),
      transactions: block.transactions?.length ?? 0,
    };
  });

  await check("Node synchronization", async () => {
    const response = await call("eth_syncing");

    return {
      syncing: response.result !== false,
    };
  });

  await sleep(3000);

  await check("Block progression", async () => {
    const response = await call("eth_blockNumber");
    const secondBlock = hexToNumber(response.result);

    if (secondBlock < firstBlock) {
      throw new Error(`Block moved backwards: ${firstBlock} -> ${secondBlock}`);
    }

    return {
      before: firstBlock,
      after: secondBlock,
      advancedBy: secondBlock - firstBlock,
    };
  });

  await check("Transaction pool API", async () => {
    const response = await call("txpool_status");
    const status = response.result;

    return {
      pending: hexToNumber(status.pending),
      queued: hexToNumber(status.queued),
    };
  });

  return checks;
}

/**
 * Print the checks as a fixed-width table headed by the endpoint tested.
 *
 * @param {string} endpoint  The RPC URL that was probed.
 * @param {Date} startedAt   When the run began.
 * @param {object[]} checks  Rows from `runChecks`.
 * @returns {number}  How many checks failed.
 */
function report(endpoint, startedAt, checks) {
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;

  const WIDTH = 96;
  const NAME = 27;
  const STATUS = 6;
  const LATENCY = 10;
  const RESULT = WIDTH - NAME - STATUS - LATENCY - 9;

  function clip(value, width) {
    const text = String(value).replace(/\s+/g, " ");

    return text.length > width
      ? text.slice(0, width - 3) + "..."
      : text.padEnd(width);
  }

  const separator = [
    "-".repeat(NAME),
    "-".repeat(STATUS),
    "-".repeat(LATENCY),
    "-".repeat(RESULT),
  ].join("-+-");

  /*- Centre a line in the table's width, rather than padStart to a
   *  literal, so the endpoint and the timestamp stay centred whatever
   *  their length. */
  const centre = (text) => text.padStart(Math.floor((WIDTH + text.length) / 2));

  console.log("\n" + "=".repeat(WIDTH));
  console.log(centre("RPC HEALTH CHECK"));
  console.log(centre(endpoint));
  console.log(centre(fmtStart(startedAt)));
  console.log("=".repeat(WIDTH));

  console.log(
    [
      clip("CHECK", NAME),
      clip("STATUS", STATUS),
      clip("TIME", LATENCY),
      clip("RESULT", RESULT),
    ].join(" | "),
  );

  console.log(separator);

  for (const item of checks) {
    const result = item.ok
      ? typeof item.result === "string"
        ? item.result
        : JSON.stringify(item.result)
      : item.error;

    console.log(
      [
        clip(item.name, NAME),
        clip(item.ok ? "PASS" : "FAIL", STATUS),
        clip(`${item.latencyMs} ms`, LATENCY),
        clip(result, RESULT),
      ].join(" | "),
    );
  }

  console.log("=".repeat(WIDTH));
  console.log(
    `Overall: ${failed === 0 ? "PASS" : "FAIL"} ` +
      `(${passed}/${checks.length} checks passed)`,
  );

  return failed;
}

/**
 * Resolve the endpoint, probe it, print the table, and set the exit
 * status from the result.
 *
 * @param {string[]} [argv]  Arguments after the node/script pair.
 * @returns {Promise<void>}
 */
async function main(argv = process.argv.slice(2)) {
  /*- `from: "user"` because argv is already stripped of the node and
   *  script entries.  Commander handles --help and -h itself, printing
   *  to stdout and exiting 0, and refuses a bad option value with a
   *  message naming it. */
  const program = buildProgram().parse(argv, { from: "user" });
  const endpoint = program.opts().rpcEndpoint;
  /*- Taken before the first request, not at print time: the run spans
   *  several seconds of network calls plus a deliberate three-second
   *  wait for block progression, and the moment that matters for lining
   *  this up against a log is when it started asking. */
  const startedAt = new Date();
  const checks = await runChecks(endpoint);
  process.exitCode = report(endpoint, startedAt, checks) === 0 ? 0 : 1;
}

/*- Gated so requiring this file from a test does not fire seven RPC
 *  calls and a three-second wait, the same arrangement every tool in
 *  this directory uses. */
if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_RPC,
  parseEndpoint,
  buildProgram,
  rpc,
  hexToNumber,
  fmtStart,
  blockAge,
  runChecks,
  report,
  main,
};
