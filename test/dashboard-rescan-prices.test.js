"use strict";

/**
 * @file test/dashboard-rescan-prices.test.js
 * @description The Re-scan Prices dialog (`public/dashboard-rescan-prices.js`),
 *   opened from the real `tplRescanPricesModal` template in
 *   `public/index.html`. Uses jsdom (via `global-jsdom/register`) so the
 *   browser module can be imported directly. A `globalThis.fetch` stub
 *   records every request. The test runner's mocked `setTimeout` means
 *   the dialog's completion poll runs only when a test advances it.
 *
 *   Pinned:
 *   - The dialog offers no options, so its request carries only the
 *     position key.
 *   - The action waits for the position to be managed.
 *   - The dialog closes itself once the re-scan reports complete.
 */

require("global-jsdom/register");

const {
  describe,
  it,
  before,
  beforeEach,
  afterEach,
  mock,
} = require("node:test");
const assert = require("node:assert/strict");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const KEY = `pulsechain-${WALLET}-${PM}-1`;

let dialog;
let requests;

/** Copy the real dialog template from public/index.html into the page. */
function installTemplate() {
  const page = indexHtmlDocument();
  const tpl = page.getElementById("tplRescanPricesModal");
  const copy = document.importNode(tpl, true);
  document.body.replaceChildren(copy);
}

/**
 * A polled status in which the active position has `fields`.
 *
 * @param {object} fields  The position's published state.
 * @returns {object}  Shaped as the dashboard's flattened status.
 */
function statusWith(fields) {
  return {
    guaranteedDashboardHasPolledMs: 1,
    rescanPricesTimeoutMs: 60_000,
    _allPositionStates: { [KEY]: fields },
  };
}

/** Let the dialog's pending promise chain run through. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The open dialog, or null. */
const overlay = () => document.getElementById("rescanPricesModal");

before(async () => {
  dialog = await import("../public/dashboard-rescan-prices.js");
  const { posStore } = await import("../public/dashboard-positions-store.js");
  posStore.add({
    walletAddress: WALLET,
    contractAddress: PM,
    positionType: "nft",
    tokenId: "1",
  });
  posStore.select(0);
});

beforeEach(() => {
  installTemplate();
  requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
  const open = overlay();
  if (open !== null) open.remove();
});

describe("Re-scan Prices dialog", () => {
  it("offers no options", () => {
    dialog.openRescanPricesDialog(() => statusWith({ status: "running" }));
    const open = overlay();
    assert.notEqual(open, null, "the dialog opened");
    const inputs = open.querySelectorAll("input");
    assert.equal(inputs.length, 0);
  });

  it("sends only the position key", async () => {
    dialog.openRescanPricesDialog(() => statusWith({ status: "running" }));
    overlay().querySelector("#rescanPricesGoBtn").click();
    await settle();
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.url, "/api/position/rescan-prices");
    assert.equal(request.init.method, "POST");
    const body = JSON.parse(request.init.body);
    assert.deepEqual(body, { positionKey: KEY });
  });

  it("shows the server's reason when it refuses, and hands the button back", async () => {
    const reason = "Re-scan Prices only applies to a managed position.";
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      const refusal = { ok: false, error: "not-managed", message: reason };
      return { ok: false, status: 409, json: async () => refusal };
    };
    dialog.openRescanPricesDialog(() => statusWith({ status: "running" }));
    const go = overlay().querySelector("#rescanPricesGoBtn");
    go.click();
    await settle();
    const notice = overlay().querySelector('[data-tpl="notManaged"]');
    const shown = notice.classList.contains("9mm-pos-mgr-is-shown");
    assert.equal(shown, true);
    assert.equal(notice.textContent, reason);
    assert.equal(go.disabled, false, "the button is handed back");
  });

  it("waits for the position to be managed", () => {
    dialog.openRescanPricesDialog(() => statusWith({ status: "stopped" }));
    const go = overlay().querySelector("#rescanPricesGoBtn");
    const notice = overlay().querySelector('[data-tpl="notManaged"]');
    const shown = notice.classList.contains("9mm-pos-mgr-is-shown");
    assert.equal(go.disabled, true);
    assert.equal(shown, true);
  });

  it("closes itself once the re-scan reports complete", async () => {
    let status = statusWith({ status: "running", lifetimeScanComplete: false });
    dialog.openRescanPricesDialog(() => status);
    overlay().querySelector("#rescanPricesGoBtn").click();
    await settle();
    mock.timers.tick(1);
    const whileRunning = overlay();
    assert.notEqual(whileRunning, null, "still open while the scan runs");
    status = statusWith({ status: "running", lifetimeScanComplete: true });
    mock.timers.tick(1);
    const afterDone = overlay();
    assert.equal(afterDone, null, "closed when the scan finished");
  });
});
