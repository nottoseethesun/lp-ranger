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
 * That fetch is not cheap: every RPC request goes through the 250 ms
 * global queue, so it is a multi-minute chain scan competing with the
 * bot for that queue.
 *
 * `hasPolled` is the half of the check that is easy to read as
 * belt-and-braces. The managed Set is also restored from localStorage
 * for instant badge render, so before a poll lands it can be a
 * carry-over from a previous session — the server may have retired the
 * position while the page was closed. Suppressing on that stale value
 * would leave a genuinely unmanaged position with empty KPIs and
 * nothing to populate them.
 *
 * Driven through the real exported decision, not a copy of it
 * (CLAUDE-TESTING.md § No Mirroring).
 */

"use strict";

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let shouldSkipUnmanagedFetch;

before(async () => {
  ({ shouldSkipUnmanagedFetch } =
    await import("../public/dashboard-unmanaged.js"));
});

describe("shouldSkipUnmanagedFetch", () => {
  it("skips when a poll has landed and the bot owns the position", () => {
    /*- The case that cost two full chain scans per startup. */
    assert.equal(
      shouldSkipUnmanagedFetch({ isManaged: true, hasPolled: true }),
      true,
    );
  });

  it("fetches when a poll has landed and the position is unmanaged", () => {
    assert.equal(
      shouldSkipUnmanagedFetch({ isManaged: false, hasPolled: true }),
      false,
    );
  });

  it("fetches when managed but NO poll has landed", () => {
    /*- The staleness case.  Before any /api/status response the managed
     *  Set may be a localStorage carry-over from a previous session, so
     *  it cannot be trusted to suppress a fetch — a genuinely unmanaged
     *  position would be left with nothing to populate its KPIs. */
    assert.equal(
      shouldSkipUnmanagedFetch({ isManaged: true, hasPolled: false }),
      false,
    );
  });

  it("fetches when neither", () => {
    assert.equal(
      shouldSkipUnmanagedFetch({ isManaged: false, hasPolled: false }),
      false,
    );
  });

  it("treats absent flags as 'do not suppress'", () => {
    /*- Suppressing is the destructive direction: it leaves a position
     *  with no data source.  An unknown input must fall through to the
     *  fetch, never to the skip. */
    for (const state of [
      {},
      { isManaged: true },
      { hasPolled: true },
      { isManaged: undefined, hasPolled: undefined },
      { isManaged: null, hasPolled: null },
    ]) {
      assert.equal(
        shouldSkipUnmanagedFetch(state),
        false,
        `${JSON.stringify(state)} must not suppress the fetch`,
      );
    }
  });

  it("does not accept truthy non-booleans as a decision", () => {
    /*- Explicit === checks, per the project's type-check rule: a
     *  stray "false" string or a 1 must not be read as a yes. */
    assert.equal(
      shouldSkipUnmanagedFetch({ isManaged: 1, hasPolled: 1 }),
      false,
    );
    assert.equal(
      shouldSkipUnmanagedFetch({ isManaged: "yes", hasPolled: "yes" }),
      false,
    );
  });
});

describe("the flush path consults it", () => {
  /*- The decision is pure and tested above; this pins that the one
   *  bypassing path actually calls it, and that the other call sites
   *  stay ungated on purpose. */
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "public", "dashboard-unmanaged.js"),
    "utf8",
  );

  it("gates flushPendingUnmanagedFetch", () => {
    const flush = src.slice(
      src.indexOf("export function flushPendingUnmanagedFetch"),
    );
    assert.match(flush.slice(0, 900), /shouldSkipUnmanagedFetch\(/);
  });

  it("asks the store and the poll, not localStorage directly", () => {
    assert.match(src, /isManaged:\s*isPositionManaged\(/);
    assert.match(src, /hasPolled:\s*getLastStatus\(\)\s*!==\s*null/);
  });
});
