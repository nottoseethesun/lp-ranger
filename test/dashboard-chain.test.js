"use strict";

/**
 * @file test/dashboard-chain.test.js
 * @description The dashboard learns the active chain from the server
 *   before it builds any position key or url, and both the server route
 *   and the browser module agree on what that chain is.
 *
 *   The browser half runs the real module under jsdom and asks through a
 *   scripted `fetch`, passed in where startup passes the browser's own;
 *   its console lines arrive through the `warnFn` it takes for the same
 *   purpose. The server half drives the real `GET /api/chain` handler,
 *   on the testnet with a header link and a token list of the test's
 *   own, so a route naming the shipped chain outright fails.
 */

require("global-jsdom/register");

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

const LINK = {
  displayName: "A Chain of the Test's Own",
  homepage: "https://example.org/chain",
  logo: "lp-ranger-star.png",
};
// The testnet ships with no token list, "".
const TOKEN_LIST_URL = "https://example.org/tokens.json";
const SETTINGS_DIR = makeTestTempFolder("chain-route-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "chains.json"),
  JSON.stringify({
    "pulsechain-testnet": {
      ...LINK,
      tokenList: { url: TOKEN_LIST_URL },
      // The testnet ships without these, and the app does not start without them.
      contracts: {
        positionManager: { address: "0x" + "11".repeat(20) },
        factory: "0x" + "22".repeat(20),
        swapRouter: { address: "0x" + "33".repeat(20), name: "Test Router" },
      },
    },
  }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;
process.env.CHAIN_NAME = "pulsechain-testnet";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const {
  userConfigurableRoutes,
} = require("../src/lib/user-configurable-routes");
const SERVER_DOWN = require("../app-config/app-defaults-for-user-configurable/ui-defaults_non-layout_for-server-down-scenario.json");

let chainMod;

before(async () => {
  chainMod = await import("../src/client/web/dashboard-chain.js");
});

/**
 * A scripted server: each request gets the next answer in order, and the
 * last answer repeats.
 */
function scriptedServer(answers) {
  const asked = [];
  const left = answers.slice();
  const fetchFn = async (url, init) => {
    asked.push(url);
    const next = left.length > 1 ? left.shift() : left[0];
    return next(init);
  };
  return { fetchFn, asked };
}

const names = (chainId) => async () => ({
  ok: true,
  json: async () => ({ chainId }),
});
const unreachable = async () => {
  throw new TypeError("Failed to fetch");
};
const unavailable = async () => ({ ok: false, status: 503 });
/**
 * Takes the request and never answers; only the request's own time
 * limit ends it, as with a server that hangs. A real request holds its
 * socket open meanwhile. This stand-in holds a timer instead, because
 * the limit's own timer does not keep Node's event loop alive, and
 * Node 22 cancels a test whose loop has emptied while it waits.
 */
const silent = (init) =>
  new Promise((_resolve, reject) => {
    const socket = setInterval(() => {}, 1000);
    init.signal.addEventListener("abort", () => {
      clearInterval(socket);
      reject(init.signal.reason);
    });
  });

/** Collects what `loadActiveChain` logs, formatted as the console would. */
function consoleLines() {
  const lines = [];
  const warnFn = (format, ...args) => {
    let i = 0;
    lines.push(format.replace(/%[ds]/g, () => String(args[i++])));
  };
  return { lines, warnFn };
}

/**
 * Counts what `loadActiveChain` reports to the HALTED pill's counter:
 * each request that named no chain, and the one that did.
 */
function reports() {
  const seen = { unanswered: 0, answered: 0 };
  return {
    seen,
    onUnanswered: () => seen.unanswered++,
    onAnswered: () => seen.answered++,
  };
}

describe("GET /api/chain", () => {
  it("names the active chain, what the header's chain link shows, and where its token logos are listed", () => {
    let status = null;
    let body = null;
    const routes = userConfigurableRoutes((_res, code, b) => {
      status = code;
      body = b;
    });
    routes["GET /api/chain"]({}, {});
    assert.equal(status, 200);
    assert.deepEqual(body, {
      chainId: "pulsechain-testnet",
      ...LINK,
      tokenListUrl: TOKEN_LIST_URL,
    });
  });
});

describe("dashboard-chain", () => {
  it("names no chain until the server has answered, and shows no chain link", () => {
    assert.equal(chainMod.activeChainId(), null);
    document.body.innerHTML =
      '<span id="chainLinkOn" hidden>on</span><span id="chainLink"></span>';
    chainMod.paintChainLink();
    assert.equal(document.getElementById("chainLink").children.length, 0);
    assert.equal(document.getElementById("chainLinkOn").hidden, true);
  });

  it("adopts the chain the server names, logging nothing", async () => {
    const server = scriptedServer([names("pulsechain-testnet")]);
    const logged = consoleLines();
    const counted = reports();
    const chain = await chainMod.loadActiveChain({
      fetchFn: server.fetchFn,
      warnFn: logged.warnFn,
      ...counted,
    });
    assert.equal(chain, "pulsechain-testnet");
    assert.deepEqual(server.asked, ["/api/chain"]);
    assert.equal(chainMod.activeChainId(), "pulsechain-testnet");
    assert.deepEqual(logged.lines, []);
    assert.deepEqual(counted.seen, { unanswered: 0, answered: 1 });
  });

  it("asks again until the server names a chain, logging each request that did not", async () => {
    /*-
     *  Unreachable, then an error status, then an answer naming no
     *  chain: none of them is a chain, so each is logged and followed by
     *  another request, and the answer that names one is adopted.
     */
    const server = scriptedServer([
      unreachable,
      unavailable,
      names(""),
      names("pulsechain"),
    ]);
    const logged = consoleLines();
    const counted = reports();
    const chain = await chainMod.loadActiveChain({
      fetchFn: server.fetchFn,
      askEveryMs: 1,
      warnFn: logged.warnFn,
      ...counted,
    });
    assert.equal(chain, "pulsechain");
    assert.equal(server.asked.length, 4);
    assert.equal(chainMod.activeChainId(), "pulsechain");
    assert.deepEqual(logged.lines, [
      "[chain] attempt 1: asked the server for its blockchain; it could not be reached (Failed to fetch) — asking again",
      "[chain] attempt 2: asked the server for its blockchain; it answered HTTP 503 — asking again",
      "[chain] attempt 3: asked the server for its blockchain; its answer named no blockchain — asking again",
    ]);
    /*-
     *  Each request that named no chain counts toward HALTED, once; the
     *  one that named it ends the run.
     */
    assert.deepEqual(counted.seen, { unanswered: 3, answered: 1 });
  });

  it("gives up on a request the server never answers, after the shipped wait", async () => {
    /*-
     *  The request's limit is the shipped `chainQueryTimeoutMs`, which
     *  the logged line states. A server that hangs therefore costs one
     *  bounded wait per request rather than holding startup forever.
     */
    const server = scriptedServer([silent, names("pulsechain")]);
    const logged = consoleLines();
    const chain = await chainMod.loadActiveChain({
      fetchFn: server.fetchFn,
      warnFn: logged.warnFn,
      ...reports(),
    });
    assert.equal(chain, "pulsechain");
    assert.equal(server.asked.length, 2);
    assert.deepEqual(logged.lines, [
      `[chain] attempt 1: asked the server for its blockchain; no answer within ${SERVER_DOWN.chainQueryTimeoutMs / 1000} s — asking again`,
    ]);
  });

  it("waits out the interval after a quick refusal before asking again", async () => {
    /*-
     *  A tight loop would ask again within a millisecond or two. The
     *  bound sits below the interval because a timer may fire a
     *  millisecond early by the wall clock.
     */
    const server = scriptedServer([unreachable, names("pulsechain")]);
    const logged = consoleLines();
    const startedAt = Date.now();
    await chainMod.loadActiveChain({
      fetchFn: server.fetchFn,
      askEveryMs: 200,
      warnFn: logged.warnFn,
      ...reports(),
    });
    assert.ok(Date.now() - startedAt >= 150, "asked again too soon");
    assert.equal(server.asked.length, 2);
    assert.equal(logged.lines.length, 1);
  });
});

/*-
 *  Last in the file: these learn a chain, and the cases above begin
 *  with none known.
 */
describe("the header's chain link", () => {
  /**
   * The header as index.html ships it: the "on" that introduces the
   * link, hidden, and the link's slot, empty.
   */
  function header() {
    document.body.innerHTML =
      '<span id="chainLinkOn" hidden>on</span><span id="chainLink"></span>';
  }
  const slot = () => document.getElementById("chainLink");
  const link = () => slot().querySelector("a");
  const on = () => document.getElementById("chainLinkOn");

  it("is the chain's logo, linking to its website, once the server names it", async () => {
    header();
    const server = scriptedServer([
      async () => ({
        ok: true,
        json: async () => ({
          chainId: "pulsechain-testnet",
          displayName: "A Chain",
          homepage: "https://chain.example/",
          logo: "chain-logo.png",
        }),
      }),
    ]);
    await chainMod.loadActiveChain({ fetchFn: server.fetchFn, ...reports() });
    chainMod.paintChainLink();
    assert.equal(on().hidden, false);
    assert.equal(link().href, "https://chain.example/");
    assert.equal(link().title, "Visit A Chain");
    assert.equal(slot().previousElementSibling, on(), "right after the 'on'");
    const img = link().querySelector("img");
    assert.match(img.src, /chain-logo\.png$/);
    assert.equal(img.alt, "A Chain");
  });

  it("is painted once, however often it is asked for", () => {
    chainMod.paintChainLink();
    chainMod.paintChainLink();
    assert.equal(slot().children.length, 1);
  });
});
