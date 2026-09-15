/**
 * @file test/rpc-add-dialog.test.js
 * @description Pins the Add RPC dialog's contract.
 *
 * The control this replaced was a free-text combo box that saved on
 * every `change` event, so a stray keystroke in the field re-pointed
 * every on-chain read the bot makes. Two rules follow from that, and
 * both are easy to lose in a later edit:
 *
 *   - nothing commits except Save;
 *   - Save closes the dialog on success and leaves it open on failure,
 *     so a rejected URL is still there to correct.
 *
 * Tested over the shipped `public/index.html` and the real module, not
 * a copy of either.
 */

"use strict";

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const INDEX_HTML = path.join(__dirname, "..", "public", "index.html");

let doc;
let validateRpcUrl;

before(async () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  doc = new window.DOMParser().parseFromString(html, "text/html");
  ({ validateRpcUrl } = await import("../public/dashboard-rpc-add.js"));
});

describe("the Network section's markup", () => {
  it("has no editable RPC input left", () => {
    /*- The whole point of the change: there is no field to stray into.
     *  `inRpc` was read by three modules, so a leftover would look
     *  harmless while still being the thing that saves on change. */
    assert.equal(doc.getElementById("inRpc"), null);

    assert.equal(doc.getElementById("rpcToggle"), null);
  });

  it("shows the endpoint dropdown and an Add RPC button", () => {
    assert.ok(doc.getElementById("rpcCurrent"), "the closed control");
    assert.ok(doc.getElementById("rpcList"), "the dropdown list");
    const btn = doc.getElementById("rpcAddBtn");
    assert.ok(btn, "Add RPC button");
    assert.equal(btn.textContent.trim(), "Add RPC");
  });

  it("ships the dropdown empty", () => {
    /*- Endpoint data in markup is a second source of truth, and the
     *  hardcoded version had already drifted out of the failover set.
     *  The options are filled from GET /api/rpc-endpoints. */
    assert.equal(doc.getElementById("rpcList").children.length, 0);
  });

  it("puts the row in the panel's standard prow layout", () => {
    /*- A `pcol` here left the circle-i sitting low and the label flush
     *  against the panel edge while every row above it was indented.
     *  `prow` centres the label against its control and carries the
     *  padding, so alignment matches by construction rather than by a
     *  one-off override. */
    const row = doc.getElementById("rpcCurrent").closest(".prow");
    assert.ok(row, "the control sits in a .prow");
    assert.ok(
      row.querySelector("[data-param-help]"),
      "the circle-i shares that row",
    );
  });

  it("styles Add RPC like the panel's other buttons", () => {
    /*- `pos-scan-btn` rendered it noticeably larger than the Save
     *  buttons it sits beneath. */
    assert.ok(
      doc.getElementById("rpcAddBtn").classList.contains("save-range-btn"),
    );
  });

  it("gives the dialog a Save and a Close button", () => {
    assert.ok(doc.getElementById("rpcAddModal"), "the dialog");
    assert.ok(doc.getElementById("rpcAddSaveBtn"), "Save");
    assert.ok(doc.getElementById("rpcAddCloseBtn"), "Close");
    assert.ok(doc.getElementById("rpcAddInput"), "the URL field");
  });

  it("opens closed", () => {
    assert.ok(
      doc.getElementById("rpcAddModal").classList.contains("hidden"),
      "a dialog visible on page load is a dialog nobody asked for",
    );
  });

  it("is registered with the Escape handler", () => {
    /*- Every dialog closes on Escape.  The handler works off an explicit
     *  id list in dashboard-events-manage.js, so a new dialog is opted
     *  OUT by default — telegramModal sat unregistered for exactly that
     *  reason.  Asserted against the source because the wiring is a
     *  table entry, not a computed value. */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "public", "dashboard-events-manage.js"),
      "utf8",
    );
    assert.match(src, /id:\s*"rpcAddModal"/);
    assert.match(src, /closeRpcAddModal/);
  });

  it("wires the info icon to help content that exists", () => {
    /*- `showParamHelp` no-ops on an unknown key, so a renamed entry
     *  ships a circle-i that looks live and does nothing. */
    const icons = [...doc.querySelectorAll("[data-param-help]")].map(
      (el) => el.dataset.paramHelp,
    );
    assert.ok(icons.includes("rpcUrls"), "the Network section's icon");
    assert.ok(!icons.includes("inRpc"), "the old key must be gone");
  });
});

describe("validateRpcUrl", () => {
  it("accepts an https endpoint", () => {
    assert.equal(validateRpcUrl("https://rpc.example.com"), null);
  });

  it("accepts an http endpoint", () => {
    /*- A node on the operator's own LAN is a normal, deliberate case. */
    assert.equal(validateRpcUrl("http://192.168.1.50:8545"), null);
  });

  it("accepts a path-bearing endpoint", () => {
    assert.equal(validateRpcUrl("https://rpc.example.com/v1/abc"), null);
  });

  it("rejects an empty value", () => {
    assert.match(validateRpcUrl(""), /Enter an RPC URL/);
  });

  it("rejects something that is not a URL", () => {
    assert.match(validateRpcUrl("rpc.example.com"), /not a valid URL/);
    assert.match(validateRpcUrl("just some words"), /not a valid URL/);
  });

  it("rejects a non-HTTP scheme", () => {
    /*- A typo'd scheme never recovers, unlike an endpoint that happens
     *  to be down — which is why shape is checked and reachability is
     *  not. */
    assert.match(validateRpcUrl("ws://rpc.example.com"), /http:\/\/ or https/);
    assert.match(validateRpcUrl("ftp://rpc.example.com"), /http:\/\/ or https/);
  });
});
