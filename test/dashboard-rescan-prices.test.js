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

/*- The sync signal the dialog gates on. These suites test everything
 *  EXCEPT the gate, so they assert a synced position; the gate itself is
 *  covered in "the dialog waits for the position to finish syncing". */
const SYNCED = () => true;

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
  it("offers two options, both off, and the window needs the rebuild", () => {
    /*-
     *  The first option is the expensive half — re-pricing the Per-Day
     *  table re-reads every NFT in the chain. Ticked by default it would
     *  turn a quick correction into minutes of chain reads that nobody
     *  asked for, so the default is the thing being pinned here.
     *
     *  The second only narrows the first, so it starts disabled: a
     *  window with no rebuild behind it scopes nothing.
     */
    dialog.openRescanPricesDialog(
      () => statusWith({ status: "running" }),
      SYNCED,
    );
    const open = overlay();
    assert.notEqual(open, null, "the dialog opened");
    const inputs = open.querySelectorAll("input");
    assert.equal(inputs.length, 2, "the Per-Day opt-in and its window");
    const box = open.querySelector("#rescanIncludeDailyPnl");
    assert.notEqual(box, null, "the Per-Day opt-in is present");
    assert.equal(box.type, "checkbox");
    assert.equal(box.checked, false, "unticked by default");
    const win = open.querySelector("#rescanLimitRecent");
    assert.notEqual(win, null, "the window option is present");
    assert.equal(win.checked, false, "unticked by default");
    assert.equal(win.disabled, true, "and unusable until the rebuild is on");
  });

  it("enables the window with the rebuild, and clears it again", () => {
    /*-
     *  Clearing on the way back matters: a tick left standing on a
     *  disabled control still reads as checked at submit time, which
     *  would send a window for a rebuild that is not happening.
     */
    dialog.openRescanPricesDialog(
      () => statusWith({ status: "running" }),
      SYNCED,
    );
    const open = overlay();
    const daily = open.querySelector("#rescanIncludeDailyPnl");
    const win = open.querySelector("#rescanLimitRecent");

    daily.checked = true;
    daily.dispatchEvent(new window.Event("change"));
    assert.equal(win.disabled, false, "available once the rebuild is on");

    win.checked = true;
    daily.checked = false;
    daily.dispatchEvent(new window.Event("change"));
    assert.equal(win.disabled, true, "unusable again");
    assert.equal(win.checked, false, "and no longer ticked");
  });

  it("sends the key, and does not opt in unless asked", async () => {
    dialog.openRescanPricesDialog(
      () => statusWith({ status: "running" }),
      SYNCED,
    );
    overlay().querySelector("#rescanPricesGoBtn").click();
    await settle();
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.url, "/api/position/rescan-prices");
    assert.equal(request.init.method, "POST");
    const body = JSON.parse(request.init.body);
    assert.deepEqual(body, {
      positionKey: KEY,
      includeDailyPnl: false,
      limitToRecentDays: false,
    });
  });

  it("opts in when the box is ticked", async () => {
    /*-
     *  A real boolean, not the string a form would carry: the server
     *  commits to minutes of chain reads only on `=== true`.
     */
    dialog.openRescanPricesDialog(
      () => statusWith({ status: "running" }),
      SYNCED,
    );
    overlay().querySelector("#rescanIncludeDailyPnl").checked = true;
    overlay().querySelector("#rescanPricesGoBtn").click();
    await settle();
    const body = JSON.parse(requests[0].init.body);
    assert.deepEqual(body, {
      positionKey: KEY,
      includeDailyPnl: true,
      limitToRecentDays: false,
    });
  });

  it("asks for the window only when both boxes are ticked", async () => {
    /*-
     *  A flag, not a day count: the server owns the number, so a request
     *  cannot ask for a reach the dialog never offered.
     */
    dialog.openRescanPricesDialog(
      () => statusWith({ status: "running" }),
      SYNCED,
    );
    const open = overlay();
    const daily = open.querySelector("#rescanIncludeDailyPnl");
    daily.checked = true;
    daily.dispatchEvent(new window.Event("change"));
    open.querySelector("#rescanLimitRecent").checked = true;
    open.querySelector("#rescanPricesGoBtn").click();
    await settle();
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      positionKey: KEY,
      includeDailyPnl: true,
      limitToRecentDays: true,
    });
  });

  it("starts unticked again on a later open", async () => {
    /*-
     *  The dialog is rebuilt from its template each time, so a choice
     *  made once must not quietly ride along on the next request.
     */
    dialog.openRescanPricesDialog(
      () => statusWith({ status: "running" }),
      SYNCED,
    );
    overlay().querySelector("#rescanIncludeDailyPnl").checked = true;
    overlay().remove();
    dialog.openRescanPricesDialog(
      () => statusWith({ status: "running" }),
      SYNCED,
    );
    assert.equal(
      overlay().querySelector("#rescanIncludeDailyPnl").checked,
      false,
    );
  });

  it("shows the server's reason when it refuses, and hands the button back", async () => {
    const reason = "Re-scan Prices only applies to a managed position.";
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      const refusal = { ok: false, error: "not-managed", message: reason };
      return { ok: false, status: 409, json: async () => refusal };
    };
    dialog.openRescanPricesDialog(
      () => statusWith({ status: "running" }),
      SYNCED,
    );
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
    dialog.openRescanPricesDialog(
      () => statusWith({ status: "stopped" }),
      SYNCED,
    );
    const go = overlay().querySelector("#rescanPricesGoBtn");
    const notice = overlay().querySelector('[data-tpl="notManaged"]');
    const shown = notice.classList.contains("9mm-pos-mgr-is-shown");
    assert.equal(go.disabled, true);
    assert.equal(shown, true);
  });

  it("closes itself once the re-scan reports complete", async () => {
    let status = statusWith({ status: "running", lifetimeScanComplete: false });
    dialog.openRescanPricesDialog(() => status, SYNCED);
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

describe("the dialog waits for the position to finish syncing", () => {
  /*- The operator clicked Re-scan Prices before the position had
   *  loaded. The dialog opened, the action did nothing — no request, no
   *  spinner, no message — because `_submit` returned before `_setBusy`
   *  when no position key had resolved.
   *
   *  The dialog now opens either way and says why the action is
   *  unavailable. It is NOT reached by disabling the Settings item: a
   *  greyed-out control with a tooltip makes the reason something the
   *  operator has to go looking for. */

  const RUNNING = () => statusWith({ status: "running" });

  it("disables the action and says why, while syncing", () => {
    dialog.openRescanPricesDialog(RUNNING, () => false);
    const open = overlay();
    assert.notEqual(open, null, "the dialog still opens");
    const go = open.querySelector("#rescanPricesGoBtn");
    assert.equal(go.disabled, true, "the action waits for the sync");
    const notice = open.querySelector('[data-tpl="notSynced"]');
    assert.notEqual(notice, null, "the dialog carries the explanation");
    assert.ok(
      notice.className.includes("9mm-pos-mgr-is-shown"),
      "and shows it — an unavailable action with no stated reason is the bug",
    );
    assert.match(notice.textContent, /Synced/, "it names the badge to watch");
  });

  it("treats 'not polled yet' as not synced", () => {
    /*- `isSyncComplete()` answers null until the first poll lands. Only
     *  an explicit true may enable; null is not yet an answer. */
    dialog.openRescanPricesDialog(RUNNING, () => null);
    assert.equal(
      overlay().querySelector("#rescanPricesGoBtn").disabled,
      true,
      "null is not a synced position",
    );
  });

  it("enables the action once synced, and hides the notice", () => {
    dialog.openRescanPricesDialog(RUNNING, SYNCED);
    const open = overlay();
    assert.equal(open.querySelector("#rescanPricesGoBtn").disabled, false);
    const notice = open.querySelector('[data-tpl="notSynced"]');
    assert.ok(
      !notice.className.includes("9mm-pos-mgr-is-shown"),
      "a synced position is told nothing about syncing",
    );
  });

  it("sends nothing while syncing", async () => {
    dialog.openRescanPricesDialog(RUNNING, () => false);
    overlay().querySelector("#rescanPricesGoBtn").click();
    await settle();
    assert.equal(requests.length, 0, "no request may leave while syncing");
  });

  it("reports the unmanaged reason ahead of the sync one", async () => {
    /*- One reason at a time, most fundamental first. An unmanaged
     *  position cannot be re-valued at all, so telling the operator to
     *  wait for a sync that is not running would send them nowhere. */
    dialog.openRescanPricesDialog(
      () => statusWith({ status: "stopped" }),
      () => false,
    );
    const open = overlay();
    assert.ok(
      open
        .querySelector('[data-tpl="notManaged"]')
        .className.includes("9mm-pos-mgr-is-shown"),
      "the managed requirement is the one shown",
    );
    assert.ok(
      !open
        .querySelector('[data-tpl="notSynced"]')
        .className.includes("9mm-pos-mgr-is-shown"),
      "and the sync notice stays out of the way",
    );
  });
});
