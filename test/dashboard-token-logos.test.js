"use strict";

/**
 * @file test/dashboard-token-logos.test.js
 * @description Each token's logo, left of its name in the Pool line and
 *   atop Position Stats (public/dashboard-token-logos.js). The page reads
 *   the chain's token list once, from the url the server names with the
 *   chain, and matches tokens by contract address. A token with no logo,
 *   a chain with no list, a list that cannot be read and a logo that
 *   fails to load all show the transparent placeholder.
 *
 *   Runs the real modules under jsdom, on the page's markup from
 *   public/index.html, and last drives the dashboard's own painting: a
 *   position coming on screen, the position strip's repaint, and the
 *   clearing when no position is on screen. The chain is learned through
 *   the real `loadActiveChain` and the list read through a scripted
 *   fetch, so no test asks an outside service.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { indexHtmlDocument } = require("./helpers/index-html");
const { learnUiSettings } = require("./helpers/ui-settings");

const LIST_URL = "https://list.example/tokens.json";
const HEX = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";
const WPLS = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
const UNLISTED = "0x" + "77".repeat(20);
const HEX_LOGO = "https://logos.example/hex.png";
const WPLS_LOGO = "https://logos.example/wpls.png";
// A token list in the Uniswap format, its addresses in lower case.
const LIST = {
  name: "A list of the test's own",
  tokens: [
    { address: HEX.toLowerCase(), symbol: "HEX", logoURI: HEX_LOGO },
    { address: WPLS.toLowerCase(), symbol: "WPLS", logoURI: WPLS_LOGO },
    { address: UNLISTED.replace("77", "78"), symbol: "NOLOGO" },
    { address: "0x" + "79".repeat(20), logoURI: "http://logos.example/x.png" },
  ],
};

let chain, logos;

before(async () => {
  document.body.innerHTML = indexHtmlDocument().body.innerHTML;
  chain = await import("../public/dashboard-chain.js");
  logos = await import("../public/dashboard-token-logos.js");
});

/** Have the page learn a chain whose token list is at `tokenListUrl`. */
function learnChain(tokenListUrl) {
  return chain.loadActiveChain({
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ chainId: "pulsechain", tokenListUrl }),
    }),
    onUnanswered: () => {},
    onAnswered: () => {},
  });
}

/** A scripted fetch answering with `body`, recording each url asked. */
function listServer(body, status = 200) {
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    return { ok: status < 400, status, json: async () => body };
  };
  return { asked, fetchFn };
}

describe("a token list's logos", () => {
  it("are kept by lower-case contract address, https logos only", () => {
    const map = logos.logosOfTokenList(LIST);
    assert.equal(map.get(HEX.toLowerCase()), HEX_LOGO);
    assert.equal(map.size, 2, "no entry for a token without an https logo");
  });
});

describe("the token logos the page shows", () => {
  it("are all the placeholder on a chain with no list, which nobody is asked for", async () => {
    await learnChain("");
    const server = listServer(LIST);
    await logos.loadTokenLogos({ fetchFn: server.fetchFn });
    assert.deepEqual(server.asked, []);
    assert.equal(logos.tokenLogoSrc(HEX), logos.TOKEN_LOGO_PLACEHOLDER);
  });

  it("are all the placeholder when the list cannot be read, which the console says", async () => {
    await learnChain(LIST_URL);
    const warned = [];
    await logos.loadTokenLogos({
      fetchFn: listServer(LIST, 503).fetchFn,
      warnFn: (...args) => warned.push(args.join(" ")),
    });
    assert.equal(logos.tokenLogoSrc(HEX), logos.TOKEN_LOGO_PLACEHOLDER);
    assert.equal(warned.length, 1);
    assert.ok(warned[0].includes(LIST_URL), "names the list's url");
  });

  it("come from the chain's list, matched by address in any case", async () => {
    await learnChain(LIST_URL);
    const server = listServer(LIST);
    await logos.loadTokenLogos({ fetchFn: server.fetchFn });
    assert.deepEqual(server.asked, [LIST_URL]);
    assert.equal(logos.tokenLogoSrc(HEX), HEX_LOGO);
    assert.equal(
      logos.tokenLogoSrc(HEX.toUpperCase().replace("0X", "0x")),
      HEX_LOGO,
    );
    assert.equal(logos.tokenLogoSrc(UNLISTED), logos.TOKEN_LOGO_PLACEHOLDER);
    assert.equal(logos.tokenLogoSrc(undefined), logos.TOKEN_LOGO_PLACEHOLDER);
  });

  it("show the placeholder when a logo fails to load", () => {
    const img = logos.tokenLogoImg(HEX);
    assert.equal(img.src, HEX_LOGO);
    img.dispatchEvent(new window.Event("error"));
    assert.equal(img.src, logos.TOKEN_LOGO_PLACEHOLDER);
  });

  it("sit left of each token's name in the Pool line", () => {
    logos.paintTokenPair("wsPool", "HEX", "WPLS", HEX, WPLS);
    const parts = [...document.getElementById("wsPool").childNodes];
    assert.deepEqual(
      parts.map((n) => (n.nodeName === "IMG" ? n.src : n.textContent)),
      [HEX_LOGO, "HEX", " / ", WPLS_LOGO, "WPLS"],
    );
    assert.equal(parts[0].className, "9mm-pos-mgr-token-logo");
  });

  it("sit left of each token's name atop Position Stats, smaller, and are placeholders with no position", () => {
    logos.paintStatTokenLogos({ token0: HEX, token1: UNLISTED });
    const img = (n) =>
      document.getElementById(`statT${n}Name`).previousElementSibling
        .firstElementChild;
    assert.equal(img(0).src, HEX_LOGO);
    assert.equal(img(1).src, logos.TOKEN_LOGO_PLACEHOLDER);
    assert.match(img(0).className, /9mm-pos-mgr-token-logo-sm/);
    logos.paintStatTokenLogos(null);
    assert.equal(img(0).src, logos.TOKEN_LOGO_PLACEHOLDER);
  });
});

describe("the dashboard's own painting", () => {
  const POSITION = {
    walletAddress: "0x1111111111111111111111111111111111111111",
    contractAddress: "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
    positionType: "nft",
    tokenId: "101",
    token0: HEX,
    token1: WPLS,
    token0Symbol: "HEX",
    token1Symbol: "WPLS",
    fee: 2500,
    tickLower: -100,
    tickUpper: 100,
    liquidity: "1000",
  };
  const poolLogos = () =>
    [...document.getElementById("wsPool").querySelectorAll("img")].map(
      (img) => img.src,
    );
  const statLogos = () =>
    [0, 1].map(
      (n) => document.getElementById(`statT${n}Logo`).firstElementChild.src,
    );
  let store, positions;

  before(async () => {
    /*-
     *  TEST-ONLY global swap: the position modules ask the server through
     *  the browser's fetch and take no stand-in for it. This answers for
     *  the server for the rest of the file, so it stays in place: the
     *  file runs in a process of its own, which no other file shares.
     */
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    await learnUiSettings();
    store = await import("../public/dashboard-positions-store.js");
    positions = await import("../public/dashboard-positions.js");
  });

  it("puts a position's logos in the Pool line and atop Position Stats as it comes on screen", () => {
    store._applyLocalPositionData(POSITION);
    assert.deepEqual(poolLogos(), [HEX_LOGO, WPLS_LOGO]);
    assert.deepEqual(statLogos(), [HEX_LOGO, WPLS_LOGO]);
  });

  it("paints the Pool line's logos again when the position strip repaints", () => {
    document.getElementById("wsPool").replaceChildren();
    store.posStore.add(POSITION);
    store.posStore.select(0);
    store.updatePosStripUI();
    assert.deepEqual(poolLogos(), [HEX_LOGO, WPLS_LOGO]);
  });

  it("shows placeholders atop Position Stats once no position is on screen", () => {
    positions.clearPositionDisplay();
    const none = logos.TOKEN_LOGO_PLACEHOLDER;
    assert.deepEqual(statLogos(), [none, none]);
  });
});

describe("startup", () => {
  it("reads the token list only once the Disclosure is accepted", () => {
    /*-
     *  The order lives in dashboard-init.js, whose import runs the whole
     *  page, so it is read rather than run. Startup waits on
     *  `initDisclaimer()`, which resolves when the Disclosure is accepted
     *  and never when it is declined. Only its callback starts
     *  `_afterDisclaimer`, and the list is read there and nowhere else.
     *  Until the list is read, every logo is the placeholder, which is
     *  drawn from the page itself and asks no host.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "public", "dashboard-init.js"),
      "utf8",
    );
    const gate = src.indexOf("initDisclaimer().then(");
    const gateEnd = src.indexOf("\n});", gate);
    const start = src.indexOf("_afterDisclaimer();");
    const body = src.indexOf("function _afterDisclaimer()");
    const bodyEnd = src.indexOf("} // end _afterDisclaimer");
    const read = src.indexOf("loadTokenLogos(");
    assert.ok(gate > -1, "startup waits on the Disclosure");
    assert.ok(start > gate && start < gateEnd, "then starts the page");
    assert.equal(src.split("_afterDisclaimer();").length, 2, "only there");
    assert.ok(read > body && read < bodyEnd, "which reads the list");
    assert.equal(src.split("loadTokenLogos(").length, 2, "only there");
  });
});
