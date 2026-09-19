"use strict";

/**
 * @file test/dashboard-reload-sync-gate.test.js
 * @description Reload Current Position waits for the position to finish
 *   syncing, and says so.
 *
 *   The operator opened an action dialog before the position had loaded
 *   and clicked its button, which did nothing — no request, no spinner,
 *   no message. Re-scan Prices had the same gap. Both dialogs now open
 *   either way and explain why the action is unavailable.
 *
 *   The dialog is NOT made unreachable by disabling the Settings item: a
 *   greyed-out control with a tooltip makes the reason something the
 *   operator has to go looking for.
 *
 *   Drives the exported decision against the REAL template from
 *   public/index.html, so a template that loses the notice or the
 *   button's hook fails here rather than in the browser.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { indexHtmlDocument } = require("./helpers/index-html");

const SHOWN = "9mm-pos-mgr-is-shown";

let applySyncGate;
let frag;

before(async () => {
  ({ applySyncGate } = await import("../public/dashboard-reload-flow.js"));
});

/** A fresh copy of the real confirm template. */
beforeEach(() => {
  const page = indexHtmlDocument();
  const tpl = page.getElementById("tplReloadConfirmModal");
  assert.notEqual(tpl, null, "the template must exist in public/index.html");
  document.body.replaceChildren(document.importNode(tpl.content, true));
  frag = document.body;
});

const notice = () => frag.querySelector('[data-tpl="notSynced"]');
const unmanagedNotice = () => frag.querySelector('[data-tpl="notManaged"]');
const go = () => frag.querySelector('[data-tpl="go"]');

describe("Reload Current Position waits for the sync", () => {
  it("the template carries both hooks the gate needs", () => {
    /*- Without either one the gate is a silent no-op, and the dialog
     *  offers an hours-long re-scan of a position mid-scan. */
    assert.notEqual(notice(), null, "the not-synced notice");
    assert.notEqual(go(), null, "the action button");
  });

  it("shows the reason and disables the action while syncing", () => {
    applySyncGate(frag, { managed: true, synced: false });
    assert.equal(go().disabled, true, "the action waits");
    assert.ok(
      notice().className.includes(SHOWN),
      "an unavailable action with no stated reason is the bug being fixed",
    );
    assert.match(notice().textContent, /Synced/, "it names the badge to watch");
  });

  it("treats 'not polled yet' as not synced", () => {
    /*- `isSyncComplete()` answers null until the first poll lands. Only
     *  an explicit true may enable; null is not yet an answer. */
    applySyncGate(frag, { managed: true, synced: null });
    assert.equal(go().disabled, true);
    assert.ok(notice().className.includes(SHOWN));
  });

  it("leaves a synced position alone", () => {
    applySyncGate(frag, { managed: true, synced: true });
    assert.equal(go().disabled, false, "the action is available");
    assert.ok(
      !notice().className.includes(SHOWN),
      "a synced position is told nothing about syncing",
    );
  });

  it("does not throw on a fragment missing either hook", () => {
    /*- The dialog must still open if a template edit drops one. */
    document.body.replaceChildren();
    assert.doesNotThrow(() =>
      applySyncGate(document.body, { managed: true, synced: false }),
    );
  });
});

describe("Reload Current Position needs a managed position", () => {
  /*- Reload drives its work through the running bot loop, and the
   *  server resolves the position from that loop's state
   *  (`_resolveStateAndPosition`). An unmanaged position has none, so
   *  the route answers 404 — the dialog used to let the operator click
   *  straight into it. */

  it("says unmanaged, and disables the action", () => {
    applySyncGate(frag, { managed: false, synced: true });
    assert.equal(go().disabled, true, "the action would 404");
    assert.ok(
      unmanagedNotice().className.includes(SHOWN),
      "the reason is stated before the click, not after the 404",
    );
    assert.match(unmanagedNotice().textContent, /Manage/, "it names the fix");
  });

  it("shows the unmanaged reason ahead of the sync one", () => {
    /*- One reason at a time, most fundamental first. An unmanaged
     *  position cannot be reloaded at all, so telling the operator to
     *  wait for a sync that is not running would send them nowhere. */
    applySyncGate(frag, { managed: false, synced: false });
    assert.ok(unmanagedNotice().className.includes(SHOWN), "unmanaged shown");
    assert.ok(
      !notice().className.includes(SHOWN),
      "and the sync notice stays out of the way",
    );
  });

  it("treats a missing managed flag as unmanaged", () => {
    applySyncGate(frag, { synced: true });
    assert.equal(go().disabled, true, "absent is not managed");
  });
});
