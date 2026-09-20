"use strict";

/**
 * @file test/dashboard-token-decimals-synced-gate.test.js
 * @description
 * The token-decimals override in Pool Details is gated on the app's
 * single Synced state.
 *
 * Reported during 0.8.15 burn-in: Pool Details told the operator that the
 * decimals for both HEX tokens "couldn't be read on-chain" and to enter
 * the correct values, while the app had not finished syncing. Nothing had
 * failed — the data simply had not loaded.
 *
 * Synced is one state for the whole app, not per position: it is not true
 * until every position's data has loaded, managed and unmanaged alike. So
 * it is the only honest answer to "has anything read these decimals yet?"
 * and it is the gate for both halves of this form:
 *
 *   - the fields are enabled only while Synced;
 *   - the check that produces the warning runs only while Synced, and any
 *     warning is cleared whenever Synced is false.
 *
 * It moves in both directions, and the form follows it both ways: a drop
 * back to syncing re-disables the fields and clears the warning rather
 * than leaving an accusation standing against data being reloaded.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod, store;

before(async () => {
  mod = await import("../public/dashboard-token-decimals.js");
  store = await import("../public/dashboard-positions-store.js");
});

/** The two token blocks, as Pool Details renders them. */
function renderDialog() {
  document.body.innerHTML = [0, 1]
    .map(
      (i) => `
      <div id="pdDecimalsForm${i}">
      <input type="number" id="pdDecimals${i}">
      <input type="checkbox" id="pdDecimalsForce${i}">
      <button id="pdDecimalsSave${i}">Save</button>
      <span id="pdDecimalsBad${i}" hidden>couldn't be read</span>
      <span id="pdDecimalsOk${i}">only change this if…</span>
      </div>`,
    )
    .join("");
}

const el = (id) => document.getElementById(id);

/** Mark the active position managed (or not), the way the poll does. */
function setManaged(on) {
  store.updateManagedPositions(
    on ? [{ tokenId: "162980", status: "running" }] : [],
    {},
  );
}

beforeEach(() => {
  renderDialog();
  localStorage.clear();
  store.posStore.entries.length = 0;
  store.posStore.entries.push({
    tokenId: "162980",
    token0: "0xA",
    token1: "0xB",
    fee: 2500,
  });
  store.posStore.activeIdx = 0;
  /*- Managed by default: the form exists only for managed positions, so
   *  the Synced cases below are all managed ones. Seeded through the same
   *  call the poll uses, not a test-only back door. */
  setManaged(true);
});

/* ── the decision ─────────────────────────────────────────────────── */

describe("_shouldWarn — Synced gates the check", () => {
  it("never warns while unsynced, whatever the value looks like", () => {
    /*- The reported bug. The check must not run at all before Synced —
     *  including for values that would be rejected once it does. */
    for (const d of [undefined, null, NaN, "8", -1, 78, 8.5, 8]) {
      assert.equal(
        mod._shouldWarn(false, d),
        false,
        `unsynced with ${String(d)} must not warn`,
      );
    }
  });

  it("warns once Synced if the decimals are unusable", () => {
    /*- Suppressing the false alarm must not suppress the real one: this
     *  is what the override exists to let the operator repair. */
    for (const d of [undefined, null, NaN, "8", -1, 78, 8.5]) {
      assert.equal(
        mod._shouldWarn(true, d),
        true,
        `synced with ${String(d)} must warn`,
      );
    }
  });

  it("stays quiet once Synced if the decimals are valid", () => {
    for (const d of [0, 6, 8, 18, 77]) {
      assert.equal(mod._shouldWarn(true, d), false, `${d} is valid`);
    }
  });

  it("treats zero decimals as valid, not as missing", () => {
    /*- 0 is falsy; a truthiness check would call a legitimate
     *  zero-decimal token unreadable. */
    assert.equal(mod._shouldWarn(true, 0), false);
  });

  it("the same value flips with Synced, not with the value", () => {
    /*- The distinction the whole fix rests on. */
    assert.equal(mod._shouldWarn(true, undefined), true);
    assert.equal(mod._shouldWarn(false, undefined), false);
  });
});

/* ── the rendered form ────────────────────────────────────────────── */

describe("populateDecimalsOverride — while unsynced", () => {
  /*- No poll has landed in this process, so isSyncComplete() is null:
   *  the not-synced state the operator hit. */

  it("disables every control of both mini-forms", () => {
    mod.populateDecimalsOverride();
    for (const i of [0, 1]) {
      for (const id of ["pdDecimals", "pdDecimalsForce", "pdDecimalsSave"]) {
        assert.equal(el(id + i).disabled, true, `${id}${i} must be disabled`);
      }
    }
  });

  it("shows no warning — only the neutral advisory", () => {
    mod.populateDecimalsOverride();
    for (const i of [0, 1]) {
      assert.equal(el("pdDecimalsBad" + i).hidden, true, "no accusation");
      assert.equal(el("pdDecimalsOk" + i).hidden, false, "advisory stays");
    }
  });

  it("clears a warning that was already on screen", () => {
    /*- Dropping back to syncing must remove an existing warning, not
     *  leave it standing against data that is being reloaded. */
    el("pdDecimalsBad0").hidden = false;
    el("pdDecimalsOk0").hidden = true;
    mod.populateDecimalsOverride();
    assert.equal(el("pdDecimalsBad0").hidden, true);
    assert.equal(el("pdDecimalsOk0").hidden, false);
  });

  it("leaves the field empty rather than inventing a value", () => {
    mod.populateDecimalsOverride();
    assert.equal(el("pdDecimals0").value, "");
  });

  it("survives the dialog not being in the DOM", () => {
    document.body.innerHTML = "";
    assert.doesNotThrow(() => mod.populateDecimalsOverride());
  });
});

/* ── following Synced in both directions ──────────────────────────── */

describe("refreshDecimalsOverrideOnPoll", () => {
  function openDialog() {
    const m = document.createElement("div");
    m.id = "poolDetailsModal";
    document.body.appendChild(m);
    return m;
  }

  it("does nothing while the dialog is closed", () => {
    const m = openDialog();
    m.className = "hidden";
    el("pdDecimals0").disabled = false;
    mod.refreshDecimalsOverrideOnPoll();
    assert.equal(el("pdDecimals0").disabled, false, "closed: left alone");
  });

  it("repaints an open dialog whose painted state is unknown", () => {
    /*- Unsynced in this process, so a repaint must disable the form and
     *  clear any warning left on screen. */
    openDialog();
    el("pdDecimals0").disabled = false;
    el("pdDecimalsBad0").hidden = false;
    mod.refreshDecimalsOverrideOnPoll();
    assert.equal(el("pdDecimals0").disabled, true);
    assert.equal(el("pdDecimalsBad0").hidden, true);
  });

  it("is a no-op on later polls while Synced has not moved", () => {
    /*- The guard that stops a three-second repaint cycle from wiping out
     *  a value the operator is midway through typing. */
    openDialog();
    mod.populateDecimalsOverride();
    el("pdDecimals0").disabled = false;
    el("pdDecimals0").value = "18";
    mod.refreshDecimalsOverrideOnPoll();
    mod.refreshDecimalsOverrideOnPoll();
    assert.equal(el("pdDecimals0").value, "18", "typing survives polls");
    assert.equal(el("pdDecimals0").disabled, false, "and no repaint ran");
  });

  it("repaints again after a close and reopen", () => {
    /*- Closing clears the painted marker, so a reopen is never skipped
     *  as "already current". */
    const m = openDialog();
    mod.populateDecimalsOverride();
    m.className = "hidden";
    mod.refreshDecimalsOverrideOnPoll(); // observes the close
    m.className = "";
    el("pdDecimals0").disabled = false;
    mod.refreshDecimalsOverrideOnPoll();
    assert.equal(el("pdDecimals0").disabled, true, "reopen repaints");
  });

  it("survives Pool Details being absent entirely", () => {
    document.body.innerHTML = "";
    assert.doesNotThrow(() => mod.refreshDecimalsOverrideOnPoll());
  });
});

/* ── the wiring that makes it live ────────────────────────────────── */

describe("poll wiring", () => {
  it("the refresh is called from the dashboard's status poll", () => {
    /*- Riding the existing poll is what keeps this at the base heartbeat
     *  with no timer and no cadence of its own. If the call were dropped
     *  the form would freeze in whatever state it was opened with. */
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "public", "dashboard-data.js"),
      "utf8",
    );
    assert.match(src, /refreshDecimalsOverrideOnPoll\(\);/);
    assert.match(src, /import \{ refreshDecimalsOverrideOnPoll \}/);
  });
});

/* ── LP Browser controls row ──────────────────────────────────────── */

describe("LP Browser: the Stats pill shares the controls row", () => {
  /*- `.pos-search-row` is a wrapping flex line holding three toggles and
   *  the Stats pill. The four sat right at the row's width inside the
   *  870px browser modal, so the longest label tipped Stats onto a line
   *  of its own. Shortening it is what buys the room back. */
  const fs = require("node:fs");
  const path = require("node:path");
  const html = () =>
    fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

  it("the New Window toggle uses the short label", () => {
    assert.match(html(), /<span>New Window<\/span>/);
    assert.equal(
      html().includes("Open in New Window"),
      false,
      "the long label is what pushed Stats off the row",
    );
  });

  it("the full wording survives on the title attribute", () => {
    /*- Shortening the visible label must not cost the explanation. */
    assert.match(
      html(),
      /title="Open selected position in a new browser window"/,
    );
  });

  it("Stats still sits inside that same controls row", () => {
    /*- It was never in a row of its own — it wrapped out of this one.
     *  If it were ever moved to its own container the width fix above
     *  would be pointless and this would catch it. */
    const src = html();
    const row = src.slice(
      src.indexOf('<div class="pos-search-row'),
      src.indexOf("</div>", src.indexOf('id="posStatsTip"')),
    );
    assert.match(row, /id="posNewTabToggle"/, "toggles are in the row");
    assert.match(row, /id="posStatsTip"/, "and so is the Stats pill");
  });
});

/* ── unmanaged positions get no form at all ───────────────────────── */

describe("unmanaged: the form is not shown and nothing is evaluated", () => {
  /*- The override's only correction is a historical one — it re-values
   *  what the bot already recorded. An unmanaged position has no recorded
   *  history to correct, so the form can do nothing for it. Hidden
   *  outright rather than disabled: a greyed control invites the operator
   *  to hunt for what would unlock it. */

  it("hides both mini-forms", () => {
    setManaged(false);
    mod.populateDecimalsOverride();
    assert.equal(el("pdDecimalsForm0").hidden, true);
    assert.equal(el("pdDecimalsForm1").hidden, true);
  });

  it("produces no warning, and leaves none behind", () => {
    /*- The reported bug: an unmanaged position claiming both tokens were
     *  unreadable. The check must not run at all. */
    el("pdDecimalsBad0").hidden = false;
    setManaged(false);
    mod.populateDecimalsOverride();
    assert.equal(
      el("pdDecimalsForm0").hidden,
      true,
      "the notice lives inside the hidden wrapper, so it cannot show",
    );
  });

  it("shows the forms again once the position is managed", () => {
    setManaged(false);
    mod.populateDecimalsOverride();
    assert.equal(el("pdDecimalsForm0").hidden, true);

    setManaged(true);
    mod.populateDecimalsOverride();
    assert.equal(el("pdDecimalsForm0").hidden, false, "Manage brings it in");
  });

  it("the poll picks up a change in managed state", () => {
    /*- Clicking Manage while Pool Details is open must bring the forms
     *  in without a close and reopen. */
    const m = document.createElement("div");
    m.id = "poolDetailsModal";
    document.body.appendChild(m);

    setManaged(false);
    mod.populateDecimalsOverride();
    assert.equal(el("pdDecimalsForm0").hidden, true);

    setManaged(true);
    mod.refreshDecimalsOverrideOnPoll();
    assert.equal(el("pdDecimalsForm0").hidden, false);
  });
});

/* ── Re-scan Prices dialog chrome ─────────────────────────────────── */

describe("Re-scan Prices: the tool header", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (f) =>
    fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");

  it("the wrench and the title share one header row", () => {
    /*- Stacked, the icon sat above the title. They are siblings in a
     *  flex row now so the wrench is to its left. */
    const html = read("index.html");
    const head = html.slice(
      html.indexOf('<div class="9mm-pos-mgr-modal-tool-head">'),
      html.indexOf("</div>", html.indexOf("<h3>Re-scan Prices</h3>")),
    );
    assert.match(head, /modal-tool-icon/, "the wrench is in the row");
    assert.match(head, /<h3>Re-scan Prices<\/h3>/, "and so is the title");
  });

  it("the row centres them against each other", () => {
    const css = read("9mm-pos-mgr.css");
    const i = css.indexOf("mm-pos-mgr-modal-tool-head {");
    const rule = css.slice(i, css.indexOf("}", i));
    assert.match(rule, /display:\s*flex/);
    assert.match(rule, /align-items:\s*center/, "vertical centring");
  });

  it("the title's own margins are cleared so centring holds", () => {
    /*- An h3 keeps its block margins inside a flex row, which would push
     *  it off the icon's centre line. */
    const css = read("9mm-pos-mgr.css");
    const i = css.indexOf("mm-pos-mgr-modal-tool-head h3 {");
    assert.notEqual(i, -1, "the override must exist");
    assert.match(css.slice(i, css.indexOf("}", i)), /margin:\s*0/);
  });

  it("the notice slot collapses when empty", () => {
    /*- Reserving its height cost three blank lines above the window
     *  checkbox and pushed it below the fold. */
    const css = read("9mm-pos-mgr.css");
    const i = css.indexOf("mm-pos-mgr-dialog-notice {");
    assert.notEqual(i, -1, "the notice rule must exist");
    const rule = css.slice(i, css.indexOf("}", i));
    assert.match(rule, /display:\s*none/);
    assert.equal(/min-height/.test(rule), false, "no reserved height");
  });
});
