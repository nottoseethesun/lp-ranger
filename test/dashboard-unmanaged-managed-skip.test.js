/**
 * @file test/dashboard-unmanaged-managed-skip.test.js
 * @description The dashboard must not scan a position the bot owns.
 *
 * A position is never both managed and unmanaged, but on a cold load
 * the browser is asked before it can answer. `isPositionManaged()`
 * reads a Set filled from `/api/status`, and the bot starts its
 * positions on a stagger, so for the first minute a naive check answers
 * "not managed" and the dashboard fetches unmanaged details for a chain
 * the bot is about to scan itself — two full passes over every NFT.
 *
 * That fetch is not cheap: every RPC request goes through the paced
 * global queue, so it is a multi-minute chain scan competing with the
 * bot for that queue.
 *
 * So the details request a locked page held back waits until a status
 * answer has been read. The managed Set is also restored from
 * localStorage for instant badge render, so before a poll lands it can
 * be a carry-over from a previous session — the server may have retired
 * the position while the page was closed. Neither skipping nor sending
 * can be decided on it: skipping would leave a genuinely unmanaged
 * position with empty KPIs, and sending would scan a managed one twice.
 *
 * Driven through the real exported decision, not a copy of it
 * (CLAUDE-TESTING.md § No Mirroring). The status handler's own order is
 * driven through the page's poll in test/dashboard-wallet-poll.test.js.
 */

"use strict";

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let pendingFetchStep;

before(async () => {
  ({ pendingFetchStep } =
    await import("../src/client/web/js/dashboard-unmanaged.js"));
});

describe("pendingFetchStep", () => {
  it("skips when a poll has landed and the bot owns the position", () => {
    /*- The case that cost two full chain scans per startup. */
    assert.equal(
      pendingFetchStep({ isManaged: true, hasPolled: true }),
      "skip",
    );
  });

  it("sends when a poll has landed and the position is unmanaged", () => {
    assert.equal(
      pendingFetchStep({ isManaged: false, hasPolled: true }),
      "send",
    );
  });

  it("waits while no poll has landed, managed or not", () => {
    /*- The staleness case.  Before any /api/status response the managed
     *  Set may be a localStorage carry-over from a previous session: it
     *  can decide neither way.  The status handler asks again once it
     *  has read an answer. */
    assert.equal(
      pendingFetchStep({ isManaged: true, hasPolled: false }),
      "wait",
    );
    assert.equal(
      pendingFetchStep({ isManaged: false, hasPolled: false }),
      "wait",
    );
  });

  it("treats an unknown poll state as no poll, and an unknown owner as unmanaged", () => {
    /*- Skipping is the destructive direction: it leaves a position with
     *  no data source.  An unknown owner, once a poll has landed, falls
     *  through to the send, never to the skip. */
    for (const state of [
      {},
      { isManaged: true },
      { hasPolled: undefined },
      { isManaged: null, hasPolled: null },
    ])
      assert.equal(pendingFetchStep(state), "wait", JSON.stringify(state));
    for (const state of [
      { hasPolled: true },
      { isManaged: undefined, hasPolled: true },
      { isManaged: null, hasPolled: true },
    ])
      assert.equal(pendingFetchStep(state), "send", JSON.stringify(state));
  });

  it("does not accept truthy non-booleans as a decision", () => {
    /*- Explicit === checks, per the project's type-check rule: a
     *  stray "false" string or a 1 must not be read as a yes. */
    assert.equal(pendingFetchStep({ isManaged: 1, hasPolled: 1 }), "wait");
    assert.equal(
      pendingFetchStep({ isManaged: "yes", hasPolled: true }),
      "send",
    );
  });
});

describe("the flush path consults it", () => {
  /*- The decision is pure and tested above; this pins that the one
   *  bypassing path actually calls it. */
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "src",
      "client",
      "web",
      "js",
      "dashboard-unmanaged.js",
    ),
    "utf8",
  );

  it("gates flushPendingUnmanagedFetch", () => {
    const flush = src.slice(
      src.indexOf("export function flushPendingUnmanagedFetch"),
    );
    assert.match(flush.slice(0, 900), /pendingFetchStep\(/);
  });

  it("asks the store and the poll, not localStorage directly", () => {
    assert.match(src, /isManaged:\s*isPositionManaged\(/);
    assert.match(src, /hasPolled:\s*getLastStatus\(\)\s*!==\s*null/);
  });
});
