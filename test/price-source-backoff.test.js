"use strict";

/**
 * @file test/price-source-backoff.test.js
 * @description One 429 backoff, shared by every price source.
 *
 *   Measured on a 132-epoch rebuild against GeckoTerminal: 239 retries
 *   and 131 calls that gave up with no price at all. A figure that gave
 *   up is not a slow figure — it is a missing one, and an epoch whose
 *   price is unknown is withheld from the Per-Day table.
 *
 *   The per-call schedule alone cannot fix that: it restarts at its
 *   first delay for every caller, so under a sustained refusal each one
 *   rediscovers the limit from scratch. The streak is what makes the
 *   process as a whole back off.
 *
 *   Two independent implementations used to exist — `price-fetcher.js`
 *   for OHLCV and `gecko-pool-cache.js` for pool info — and the second
 *   never signalled the shared limiter, so a refusal in one could not
 *   slow the other though both are the same service refusing the same
 *   process.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const backoff = require("../src/price-source-backoff");
const {
  retryOn429,
  penaltyWaitMs,
  note429,
  noteOk,
  _setDelays,
  _resetForTest,
  _MAX_PENALTY_MS,
} = backoff;

beforeEach(() => {
  _resetForTest();
  /*- Near-zero so the suite does not pay the real schedule. */
  _setDelays([1, 1, 1]);
});

describe("retrying one refused call", () => {
  it("returns a success without retrying", async () => {
    let calls = 0;
    const res = await retryOn429({
      source: "gecko",
      label: "x",
      fetchOnce: async () => (calls++, { status: 200 }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 1, "a 200 is not retried");
  });

  it("retries a 429 and returns the eventual success", async () => {
    let calls = 0;
    const res = await retryOn429({
      source: "gecko",
      label: "x",
      fetchOnce: async () => ({ status: ++calls < 3 ? 429 : 200 }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 3, "two refusals, then through");
  });

  it("gives up after the schedule and hands back the 429", async () => {
    let calls = 0;
    const res = await retryOn429({
      source: "gecko",
      label: "x",
      fetchOnce: async () => (calls++, { status: 429 }),
    });
    assert.equal(res.status, 429, "the caller is told, not given a fake 200");
    assert.equal(calls, 4, "the first call plus three retries");
  });

  it("passes other failures straight back", async () => {
    /*- A 404 is not a rate limit. Retrying it would spend the schedule
     *  on a question that has already been answered. */
    let calls = 0;
    const res = await retryOn429({
      source: "gecko",
      label: "x",
      fetchOnce: async () => (calls++, { status: 404 }),
    });
    assert.equal(res.status, 404);
    assert.equal(calls, 1);
  });
});

describe("the penalty escalates across calls", () => {
  it("is zero before anything is refused", () => {
    assert.equal(penaltyWaitMs("gecko"), 0);
  });

  it("doubles with each consecutive refusal", () => {
    note429("gecko", 1000);
    const first = penaltyWaitMs("gecko");
    _resetForTest();
    note429("gecko", 1000);
    note429("gecko", 1000);
    note429("gecko", 1000);
    const third = penaltyWaitMs("gecko");
    assert.ok(
      third > first * 3,
      `a streak must grow faster than a repeat: ${first} then ${third}`,
    );
  });

  it("is capped, so the process recovers by itself", () => {
    for (let i = 0; i < 40; i++) note429("gecko", 10_000);
    assert.ok(
      penaltyWaitMs("gecko") <= _MAX_PENALTY_MS,
      "an uncapped penalty would strand the rebuild until a restart",
    );
  });

  it("a success clears the streak", () => {
    for (let i = 0; i < 5; i++) note429("gecko", 1000);
    noteOk("gecko");
    note429("gecko", 1000);
    /*- Back to a first-refusal penalty, not a sixth-refusal one. */
    assert.ok(
      penaltyWaitMs("gecko") <= 1000,
      "without this the penalty ratchets and never comes down",
    );
  });

  it("a successful retry clears the streak too", async () => {
    let calls = 0;
    await retryOn429({
      source: "gecko",
      label: "x",
      fetchOnce: async () => ({ status: ++calls < 2 ? 429 : 200 }),
    });
    note429("gecko", 1000);
    assert.ok(
      penaltyWaitMs("gecko") <= 1000,
      "the call ended in success, so the next refusal starts fresh",
    );
  });
});

describe("sources do not penalise each other", () => {
  it("keeps the streak per source", () => {
    for (let i = 0; i < 5; i++) note429("gecko", 1000);
    assert.ok(penaltyWaitMs("gecko") > 0, "gecko is penalised");
    assert.equal(
      penaltyWaitMs("moralis"),
      0,
      "one source refusing says nothing about another — and slowing the fallback would throw away the thing that covers the refusal",
    );
  });

  it("does not let a giving-up call leave the other source waiting", async () => {
    _setDelays([1]);
    await retryOn429({
      source: "gecko",
      label: "x",
      fetchOnce: async () => ({ status: 429 }),
    });
    assert.equal(penaltyWaitMs("moralis"), 0);
  });
});

describe("both GeckoTerminal callers share one penalty", () => {
  it("a pool-info refusal slows the OHLCV calls", () => {
    /*- The defect this replaced: `gecko-pool-cache.js` retried on its
     *  own schedule and told the limiter nothing, so its refusals were
     *  invisible to `price-fetcher.js` and vice versa. Both name the
     *  same source now, so one refusal is every caller's refusal. */
    note429("gecko", 5000);
    assert.ok(
      penaltyWaitMs("gecko") > 0,
      "the OHLCV path reads the same penalty the pool-info path raised",
    );
  });
});
