/**
 * @file util/test/check-rpc-health.test.js
 * @description
 * Tests for `check-rpc-health.js` — the probe that answers whether one
 * RPC endpoint is serving.
 *
 * Two halves. The pure parts (option parsing, hex and timestamp
 * formatting, table rendering) are called directly. The parts that talk
 * JSON-RPC run against a stub node on an ephemeral port rather than a
 * mocked `fetch`, because the tool's whole value is that it makes real
 * requests: a stubbed transport would assert the shape of a call the
 * operator never benefits from.
 *
 * No test reaches the network. The stub binds 127.0.0.1:0 and is closed
 * in `after`.
 */

"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { captureConsole } = require("./_capture");
const {
  DEFAULT_RPC,
  parseEndpoint,
  buildProgram,
  rpc,
  hexToNumber,
  fmtStart,
  blockAge,
  runChecks,
  report,
} = require("../diagnostic/check-rpc-health");

/* ---------- option parsing ---------- */

/** Parse an argv through the tool's Commander declaration. */
function opts(argv) {
  return buildProgram().parse(argv, { from: "user" }).opts();
}

/** A program that throws instead of exiting, and prints nothing. */
function quiet() {
  return buildProgram()
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
}

test("defaults to the app's first endpoint when no flag is given", () => {
  assert.equal(opts([]).rpcEndpoint, DEFAULT_RPC);
  assert.match(DEFAULT_RPC, /^https:\/\//);
});

test("--rpc-endpoint overrides the default", () => {
  assert.equal(
    opts(["--rpc-endpoint", "https://rpc.pulsechain.com"]).rpcEndpoint,
    "https://rpc.pulsechain.com",
  );
});

test("parseEndpoint accepts http and https", () => {
  assert.equal(parseEndpoint("http://localhost:8545"), "http://localhost:8545");
  assert.equal(parseEndpoint("https://a.test"), "https://a.test");
});

test("parseEndpoint rejects a non-URL, naming the problem", () => {
  assert.throws(() => parseEndpoint("not-a-url"), /not a URL/);
});

test("parseEndpoint rejects a non-http scheme", () => {
  /*- ftp parses as a URL, so the protocol check is doing the work here
   *  rather than the URL constructor. */
  assert.throws(() => parseEndpoint("ftp://x.test"), /must be http or https/);
});

test("a bad endpoint is refused during parsing, before any request", () => {
  assert.throws(
    () => quiet().parse(["--rpc-endpoint", "nope"], { from: "user" }),
    /not a URL/,
  );
});

test("an unknown option is refused rather than ignored", () => {
  assert.throws(
    () => quiet().parse(["--bogus"], { from: "user" }),
    /unknown option/,
  );
});

test("help names the tool and its one option", () => {
  const help = buildProgram().helpInformation();
  assert.match(help, /check-rpc-health/);
  assert.match(help, /--rpc-endpoint/);
  assert.match(help, /-h, --help/);
});

/* ---------- formatting ---------- */

test("hexToNumber reads a 0x quantity", () => {
  assert.equal(hexToNumber("0x171"), 369);
  assert.equal(hexToNumber("0x0"), 0);
});

test("blockAge reports seconds since the block's timestamp", () => {
  const tenAgo = Math.floor(Date.now() / 1000) - 10;
  assert.match(blockAge("0x" + tenAgo.toString(16)), /^\d+s old$/);
});

test("blockAge never reports a negative age for a future timestamp", () => {
  /*- A node a little ahead of local clock must not print "-3s old". */
  const ahead = Math.floor(Date.now() / 1000) + 300;
  assert.equal(blockAge("0x" + ahead.toString(16)), "0s old");
});

test("fmtStart leads with UTC, then local time and its zone", () => {
  const at = new Date(Date.UTC(2026, 8, 28, 19, 34, 25));
  const s = fmtStart(at);
  assert.match(
    s,
    /^2026-09-28 19:34:25 UTC \(/,
    "UTC first: the app's log timestamps in UTC, and lining the two up " +
      "is the reason a run is dated at all",
  );
  assert.match(s, /\)$/);
});

/* ---------- the table ---------- */

test("report returns the number of failures and renders every row", async () => {
  const checks = [
    { name: "one", ok: true, latencyMs: 12, result: "fine" },
    { name: "two", ok: false, latencyMs: 34, error: "boom" },
  ];
  const { out } = await captureConsole(() =>
    report("https://x.test", new Date(), checks),
  );
  const text = out.join("\n");
  assert.equal(report("https://x.test", new Date(), checks), 1);
  assert.match(text, /https:\/\/x\.test/, "the endpoint under test is shown");
  assert.match(text, /PASS/);
  assert.match(text, /FAIL/);
  assert.match(text, /boom/, "a failed check shows its error, not a blank");
  assert.match(text, /1\/2 checks passed/);
});

test("report says PASS overall only when nothing failed", async () => {
  const ok = [{ name: "one", ok: true, latencyMs: 1, result: "y" }];
  const { out } = await captureConsole(() =>
    report("https://x.test", new Date(), ok),
  );
  assert.match(out.join("\n"), /Overall: PASS \(1\/1/);
  assert.equal(report("https://x.test", new Date(), ok), 0);
});

test("report renders a non-string result as JSON", async () => {
  const checks = [
    { name: "one", ok: true, latencyMs: 1, result: { chainId: 369 } },
  ];
  const { out } = await captureConsole(() =>
    report("https://x.test", new Date(), checks),
  );
  assert.match(out.join("\n"), /chainId/);
});

/* ---------- against a stub node ---------- */

describe("talking to a node", () => {
  let server = null;
  let base = "";
  let mode = "healthy";

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { method, id } = JSON.parse(body);
        if (mode === "down") {
          res.writeHead(502, { "content-type": "text/plain" });
          return res.end("error code: 502\n");
        }
        if (mode === "garbage") {
          res.writeHead(200, { "content-type": "text/plain" });
          return res.end("<html>not json</html>");
        }
        if (mode === "rpcError") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: "method not found" },
            }),
          );
        }
        const now = Math.floor(Date.now() / 1000);
        const result =
          method === "web3_clientVersion"
            ? "erigon/test"
            : method === "eth_chainId"
              ? "0x171"
              : method === "net_version"
                ? "369"
                : method === "eth_blockNumber"
                  ? "0x64"
                  : method === "eth_syncing"
                    ? false
                    : method === "txpool_status"
                      ? { pending: "0x2", queued: "0x1" }
                      : {
                          number: "0x64",
                          hash: "0xabc",
                          timestamp: "0x" + now.toString(16),
                          transactions: [],
                        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    await new Promise((r) =>
      server.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${server.address().port}`;
        r();
      }),
    );
  });

  after(async () => {
    if (server !== null) await new Promise((r) => server.close(r));
  });

  test("rpc returns the result and how long it took", async () => {
    mode = "healthy";
    const r = await rpc(base, "web3_clientVersion");
    assert.equal(r.result, "erigon/test");
    assert.equal(typeof r.latencyMs, "number");
    assert.ok(r.latencyMs >= 0);
  });

  test("rpc surfaces an HTTP error status", async () => {
    mode = "down";
    await assert.rejects(() => rpc(base, "web3_clientVersion"), /502/);
  });

  test("rpc names a non-JSON body rather than throwing a parse error", async () => {
    /*- A proxy's HTML error page is the common case; the message has to
     *  say what came back, not "Unexpected token <". */
    mode = "garbage";
    await assert.rejects(
      () => rpc(base, "web3_clientVersion"),
      /non-JSON response/,
    );
  });

  test("rpc surfaces a JSON-RPC error member", async () => {
    mode = "rpcError";
    await assert.rejects(() => rpc(base, "web3_clientVersion"), /-32601/);
  });

  test("runChecks passes all seven against a healthy node", async () => {
    mode = "healthy";
    const checks = await runChecks(base);
    assert.equal(checks.length, 7);
    const failed = checks.filter((c) => !c.ok);
    assert.deepEqual(
      failed.map((c) => `${c.name}: ${c.error}`),
      [],
      "a healthy node must pass every check",
    );
  });

  test("runChecks records each failure and keeps going", async () => {
    /*- Stopping at the first failure loses the more useful answer:
     *  which parts still work. */
    mode = "down";
    const checks = await runChecks(base);
    assert.equal(checks.length, 7, "every check still reports a row");
    assert.ok(
      checks.every((c) => c.ok === false),
      "all seven fail when nothing answers",
    );
    assert.ok(
      checks.every((c) => typeof c.error === "string" && c.error.length > 0),
      "each failed row carries its reason",
    );
  });
});
