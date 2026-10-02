/**
 * @file test/rpc-read-retry-recovery-log.test.js
 * @description
 * A run of retry-failure lines that simply stops is ambiguous. A read
 * served by the next endpoint and a read abandoned altogether both end
 * the same way — in silence — so whoever reads the log is left deciding
 * whether the bot is working.
 *
 * `retryRead` therefore closes a run it has logged with exactly one
 * line, naming the endpoint that answered and whether that endpoint is
 * the one that had been failing. These cases pin the four things that
 * line has to get right: that it appears, that it does NOT appear when
 * nothing was logged to resolve, that it tells another endpoint serving
 * the read apart from the original one recovering, and that it counts
 * every failed attempt rather than the last.
 */

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { format } = require("node:util");

const { retryRead } = require("../src/rpc-read-retry");
const { _setSinkForTests } = require("../src/log");

/*- Both levels are captured: failures go to warn and the recovery to
 *  info, and a test that watched only one could not tell a missing
 *  recovery line from one written at the wrong level.
 *
 *  `util.format` rather than a join, because the sink is handed the
 *  format string and its arguments separately — substitution is
 *  `console.log`'s job downstream.  Joining would assert against
 *  "%s after %d" and so could not tell a correct line from a wrong
 *  one. */
function capture() {
  const info = [];
  const warn = [];
  const restore = _setSinkForTests({
    log: (...a) => info.push(format(...a)),
    warn: (...a) => warn.push(format(...a)),
  });
  return { info, warn, restore };
}

/*- Three, not two.  `failover()` runs at the TOP of each iteration, so
 *  attempt one already executes on the endpoint AFTER the one whose
 *  failure sent us here.  With only two endpoints the second attempt
 *  has nowhere further to go and lands on the same one that just
 *  failed, which is the "recovered, no failover" shape — so a genuine
 *  cross-endpoint recovery needs a third. */
const URLS = [
  "https://first.example",
  "https://second.example",
  "https://third.example",
];

const boom = () =>
  Object.assign(new Error("server response 502 Bad Gateway"), {
    code: "SERVER_ERROR",
  });

/**
 * Drive the real loop over a scripted sequence of attempt outcomes.
 *
 * `outcomes` is consumed one per ATTEMPT from a single cursor shared by
 * every provider, not one per provider. Keying it to the provider
 * instead lets a pinned endpoint replay the same throwing outcome for
 * ever, which is an infinite loop rather than a failing assertion —
 * this loop is designed never to give up. Running off the end throws
 * for the same reason: a scripting slip should fail fast, not hang.
 *
 * `advance` chooses the scenario. True moves selection on each reported
 * failure, so a later attempt runs against a different endpoint and the
 * line should report a failover. False pins selection, so the same
 * endpoint recovers and the line must not claim one.
 */
function drive(outcomes, { advance = true } = {}) {
  let cursor = 0;
  let idx = 0;
  const take = () => {
    if (cursor >= outcomes.length) {
      throw new Error(
        `test script exhausted after ${outcomes.length} attempt(s) — ` +
          "the loop never gives up, so the last outcome must succeed",
      );
    }
    const outcome = outcomes[cursor++];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const providers = URLS.map((url) => ({
    url,
    getBalance: async () => take(),
  }));
  return retryRead({
    prop: "getBalance",
    args: [],
    err: boom(),
    isFailoverable: () => true,
    failover: () => {
      if (advance && idx < providers.length - 1) idx++;
      return advance;
    },
    current: () => providers[idx],
    urlOf: (p) => p?.url ?? null,
    failedProvider: providers[0],
  });
}

describe("the read-retry loop closes a logged run with one success line", () => {
  let cap = null;
  afterEach(() => cap?.restore());

  it("logs one recovery line naming the endpoint that served the read", async () => {
    cap = capture();
    /*- Attempt one runs on the second endpoint and fails, selection
     *  moves again, attempt two succeeds on the third — the shape of a
     *  real failover, where what served the read is not what failed. */
    const value = await drive([boom(), 42n]);

    assert.equal(value, 42n);
    assert.equal(cap.warn.length, 1, "one failure line");
    const recovery = cap.info.filter((l) => l.includes("read ok"));
    assert.equal(recovery.length, 1, "exactly one recovery line");
    assert.match(recovery[0], /read ok on getBalance after 1 failed attempt/);
    assert.match(recovery[0], /served by https:\/\/third\.example/);
    assert.match(recovery[0], /failed over from https:\/\/second\.example/);
  });

  it("says no failover happened when the same endpoint recovers", async () => {
    cap = capture();
    /*- Selection pinned, so both attempts are the first endpoint: it
     *  fails once, then answers.  The 502-blip case, where a reader
     *  must not be told a failover occurred. */
    const value = await drive([boom(), 7n], { advance: false });

    assert.equal(value, 7n);
    const recovery = cap.info.filter((l) => l.includes("read ok"));
    assert.equal(recovery.length, 1);
    assert.match(
      recovery[0],
      /https:\/\/first\.example recovered, no failover/,
    );
    assert.ok(
      !recovery[0].includes("failed over from"),
      "must not claim a failover that did not happen",
    );
  });

  it("stays silent when the first attempt succeeds", async () => {
    cap = capture();
    /*- Nothing was logged on the way in, so there is nothing to
     *  resolve; a line here would bury the runs that matter. */
    const value = await drive([99n]);

    assert.equal(value, 99n);
    assert.equal(cap.warn.length, 0, "no failure line");
    assert.deepEqual(
      cap.info.filter((l) => l.includes("read ok")),
      [],
      "no recovery line without a failure to recover from",
    );
  });

  it("counts every failed attempt, not just the last", async () => {
    cap = capture();
    const value = await drive([boom(), boom(), 5n], { advance: false });

    assert.equal(value, 5n);
    assert.equal(cap.warn.length, 2, "two failure lines");
    const recovery = cap.info.filter((l) => l.includes("read ok"));
    assert.equal(recovery.length, 1, "still exactly one recovery line");
    assert.match(recovery[0], /after 2 failed attempt/);
  });
});
