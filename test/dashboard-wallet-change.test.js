"use strict";

/**
 * @file test/dashboard-wallet-change.test.js
 * @description A tab left on a wallet the server no longer holds reloads
 *   (src/client/web/js/dashboard-wallet-change.js). Once the server's
 *   status answers name a change (`walletJustChanged`), a tab holding
 *   another wallet reloads at the dashboard's start address: not while the
 *   import is under way, not while it holds no wallet, and not for its own
 *   import, whose status answer can come before the import's answer.
 *
 *   Driven through the page's own poll and import, on its markup from
 *   src/client/web/index.html, with the server's answers scripted. The
 *   navigation is taken through the module's seam, since jsdom navigates
 *   nowhere.
 */

require("global-jsdom/register");

const {
  describe,
  it,
  before,
  beforeEach,
  afterEach,
  after,
} = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const OLD = "0x1111111111111111111111111111111111111111";
const NEW = "0xAbCdEf0000000000000000000000000000000002";
const KEY = "0x" + "ab".repeat(32);
const PASSWORD = "a password typed in";
const CHANGED = { reloadIfOnPriorWallet: true, currentWallet: NEW };

const answer = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

/*-
 *  The scripted server: the wallet it holds, the change it reports,
 *  whether an import is under way, and what happens while it holds an
 *  import before answering it.
 */
const server = {
  wallet: NEW,
  change: CHANGED,
  importing: false,
  duringImport: null,
};

/** The status answer the scripted server gives. */
function statusAnswer() {
  return {
    global: {
      walletAddress: server.wallet,
      walletJustChanged: server.change,
      importingWallet: server.importing,
      managedPositions: [],
    },
    positions: {},
  };
}

let change, poll, walletMod, idle;
let navigated, restoreNavigate;
// The wallet the page's address names, lower case, and drops of it.
let pendingWallet = null;
let dropped = 0;
// What the swaps below replace, put back in `after`.
let savedFetch, savedAlert, savedOffsetParent;

before(async () => {
  /*-
   *  TEST-ONLY global swap: three, for this file's own process, each put
   *  back in `after`. The dashboard asks the server through the browser's
   *  fetch; it finds the active password field by whether it is laid out
   *  (`offsetParent`), which jsdom never reports, so every element counts
   *  as laid out here; and it alerts on a refused import.
   */
  savedFetch = globalThis.fetch;
  savedAlert = globalThis.alert;
  savedOffsetParent = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "offsetParent",
  );
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return answer(statusAnswer());
    if (url === "/api/wallet/status")
      return answer({ loaded: true, locked: false, address: server.wallet });
    if (url === "/api/wallet") {
      if (server.duringImport !== null) await server.duringImport();
      return answer({ ok: true, address: NEW });
    }
    return answer({ ok: false });
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
    get() {
      return this.parentNode;
    },
  });
  globalThis.alert = () => {};
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  change = await import("../src/client/web/js/dashboard-wallet-change.js");
  await import("../src/client/web/js/dashboard-data.js");
  poll = await import("../src/client/web/js/dashboard-data-poll.js");
  walletMod = await import("../src/client/web/js/dashboard-wallet.js");
  idle = await import("../src/client/web/js/dashboard-idle.js");
  // The router's part, as a page loading at an address hands it over.
  walletMod.injectWalletDeps({
    getPendingRouteWallet: () => pendingWallet,
    dropPendingRoute: () => {
      dropped++;
      pendingWallet = null;
    },
  });
});

beforeEach(() => {
  server.wallet = NEW;
  server.change = CHANGED;
  server.importing = false;
  server.duringImport = null;
  navigated = [];
  restoreNavigate = change._setNavigateForTests((url) => navigated.push(url));
});

afterEach(() => {
  restoreNavigate();
});

after(() => {
  globalThis.fetch = savedFetch;
  globalThis.alert = savedAlert;
  Object.defineProperty(
    window.HTMLElement.prototype,
    "offsetParent",
    savedOffsetParent,
  );
});

/** Let every request under way be answered and shown. */
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** One status poll, answered. */
async function polled() {
  poll.pollNow();
  await settled();
}

describe("whether a tab reloads on a status answer", () => {
  const changed = { walletJustChanged: CHANGED, importingWallet: false };
  const decide = (data, pageWallet, importingHere = false) =>
    change.shouldReloadForWalletChange(data, pageWallet, importingHere);

  it("reloads a tab holding the replaced wallet", () => {
    assert.equal(decide(changed, OLD), true);
  });

  it("not before any change", () => {
    assert.equal(decide({ walletJustChanged: null }, OLD), false);
  });

  it("not a tab holding the new wallet, whatever its letter case", () => {
    assert.equal(decide(changed, NEW.toLowerCase()), false);
  });

  it("not a tab holding no wallet", () => {
    assert.equal(decide(changed, null), false);
    assert.equal(decide(changed, ""), false);
  });

  it("not while the server's import is under way", () => {
    assert.equal(decide({ ...changed, importingWallet: true }, OLD), false);
  });

  it("not while this tab makes an import", () => {
    assert.equal(decide(changed, OLD, true), false);
  });

  it("not when the change asks for no reload", () => {
    const quiet = { reloadIfOnPriorWallet: false, currentWallet: NEW };
    assert.equal(decide({ ...changed, walletJustChanged: quiet }, OLD), false);
  });
});

describe("a tab polling the server", () => {
  it("reloads at the start address when it holds the replaced wallet", async () => {
    walletMod.wallet.address = OLD;
    await polled();
    assert.deepEqual(navigated, ["/"]);
  });

  it("waits while the import is under way, and reloads once it has finished", async () => {
    walletMod.wallet.address = OLD;
    server.importing = true;
    await polled();
    assert.deepEqual(navigated, []);
    server.importing = false;
    await polled();
    assert.deepEqual(navigated, ["/"]);
  });

  it("stays when it holds no wallet", async () => {
    walletMod.wallet.address = null;
    await polled();
    assert.deepEqual(navigated, []);
  });
});

describe("a page loading anew", () => {
  /**
   * Load the page's wallet from the server, the page loaded as `how`
   * says, its address naming `named` (null for the start address).
   */
  async function loadsAt(named, how) {
    pendingWallet = named === null ? null : named.toLowerCase();
    dropped = 0;
    walletMod.wallet.address = null;
    walletMod.closeWalletModal();
    const restore = idle._setPageLoadForTests(() => how);
    try {
      await walletMod.checkServerWalletStatus();
    } finally {
      restore();
    }
  }
  const opened = { discarded: false, type: "navigate" };
  const dialogOpen = () =>
    !document.getElementById("walletModal").classList.contains("hidden");

  it("at the start address takes the server's wallet, and never reloads for it", async () => {
    // What a reloaded tab loads: the claim that no tab reloads twice.
    await loadsAt(null, opened);
    assert.equal(walletMod.wallet.address, NEW);
    await polled();
    assert.deepEqual(navigated, []);
  });

  it("opened at an address naming another wallet asks for it, and stays", async () => {
    // The address the operator opens takes priority.
    await loadsAt(OLD, opened);
    assert.equal(walletMod.wallet.address, null);
    assert.equal(dialogOpen(), true);
    assert.equal(dropped, 0);
    await polled();
    assert.deepEqual(navigated, []);
  });

  it("reloaded by the browser after unloading the tab, follows the server's wallet", async () => {
    // As if it had stayed open: a tab that stays open reloads to it.
    await loadsAt(OLD, { discarded: true, type: "navigate" });
    assert.equal(dropped, 1);
    assert.equal(walletMod.wallet.address, NEW);
    assert.equal(dialogOpen(), false);
  });

  it("brought back by Back or Forward, follows the server's wallet", async () => {
    await loadsAt(OLD, { discarded: false, type: "back_forward" });
    assert.equal(dropped, 1);
    assert.equal(walletMod.wallet.address, NEW);
  });
});

describe("the tab making the import", () => {
  it("does not reload for it, on an answer naming its wallet before the import's own", async () => {
    walletMod.wallet.address = OLD;
    walletMod.wallet._pending = {
      address: NEW,
      privateKey: KEY,
      mnemonic: null,
      source: "key",
    };
    document.getElementById("keyInput").value = KEY;
    document.getElementById("keyPassword").value = PASSWORD;
    document.getElementById("keyPasswordConfirm").value = PASSWORD;
    // The server holds the new wallet, and is polled, before it answers.
    server.duringImport = () => polled();
    await walletMod.confirmWallet();
    assert.deepEqual(navigated, []);
    assert.equal(walletMod.wallet.address, NEW);
  });
});
