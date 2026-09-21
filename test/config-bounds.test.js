"use strict";

/**
 * @file test/config-bounds.test.js
 * @description Tests for `src/config-bounds.js`, which decides whether a
 *   value an operator typed into the dashboard may be saved.
 *
 *   This is the only place that decision is made. The browser used to
 *   make it, differently per control — four settings quietly rewrote
 *   what was typed and saved the rewrite, three refused with no message,
 *   and none of it bound a request that did not come from the form. So
 *   what these tests pin is not one control's manners: it is that every
 *   dashboard-settable key has a rule, that the rule refuses rather than
 *   corrects, and that the refusal names the setting so the dashboard
 *   can put the right field back.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { checkConfigValues, BOUNDS } = require("../src/config-bounds");
const { GLOBAL_KEYS, POSITION_KEYS } = require("../src/bot-config-keys");

/*- What the route hands in: values it has already resolved. */
const CTX = {
  defaultsSec: { checkIntervalSec: 300 },
  compoundMinFeeUsd: 1,
};

const check = (patch) => checkConfigValues(patch, CTX);

describe("checkConfigValues — numeric ranges", () => {
  it("accepts a value inside the range and refuses one above it", () => {
    assert.equal(check({ impermanentLossGuardPct: 50 }), null);
    const bad = check({ impermanentLossGuardPct: 150 });
    assert.equal(bad.key, "impermanentLossGuardPct");
    assert.match(bad.message, /outside what it accepts/);
  });

  it("refuses rather than clamping — the value is never corrected", () => {
    /*- The whole point of the change this file came from. A returned
     *  problem is the only outcome; there is no corrected value to
     *  hand back, so nothing downstream can save a different number
     *  than the operator entered. */
    const bad = check({ impermanentLossGuardPct: 150 });
    assert.equal(typeof bad.message, "string");
    assert.equal(bad.value, undefined);
    assert.equal(Object.keys(bad).sort().join(","), "key,message");
  });

  it("names the setting the way the dashboard labels it", () => {
    const bad = check({ maxRebalancesPerDay: 0 });
    assert.match(bad.message, /Max Rebalances per Day/);
  });

  it("refuses a fraction where the setting is whole-numbered", () => {
    assert.equal(check({ offsetToken0Pct: 50 }), null);
    assert.match(check({ offsetToken0Pct: 50.5 }).message, /whole number/);
  });

  it("allows a fraction where the form has always accepted one", () => {
    /*- The OOR threshold input is a parseFloat field; refusing 5.5 here
     *  would refuse a value the dashboard could already save. */
    assert.equal(check({ rebalanceOutOfRangeThresholdPercent: 5.5 }), null);
  });

  it("refuses a non-number, including one that arrives as text", () => {
    assert.match(
      check({ maxRebalancesPerDay: "5" }).message,
      /must be a number/,
    );
    assert.match(
      check({ maxRebalancesPerDay: NaN }).message,
      /must be a number/,
    );
  });
});

describe("checkConfigValues — RPC endpoints", () => {
  it("accepts real endpoints, including one on the operator's machine", () => {
    assert.equal(
      check({
        rpcUrls: ["https://rpc.pulsechain.com", "http://127.0.0.1:8545"],
      }),
      null,
    );
    assert.equal(check({ rpcUrls: ["https://localhost:8545"] }), null);
    assert.equal(check({ rpcUrls: ["https://rpc.example.com/v1/abc"] }), null);
  });

  it("refuses an address with no scheme, naming the entry", () => {
    const bad = check({ rpcUrls: ["rpc.pulsechain.com"] });
    assert.equal(bad.key, "rpcUrls");
    assert.match(bad.message, /rpc\.pulsechain\.com/);
    assert.match(bad.message, /http:\/\/ or https:\/\//);
  });

  it("refuses a scheme the provider cannot dial", () => {
    /*- `javascript:` parses as a URL; what keeps it out is the protocol
     *  list, not the parse. */
    assert.match(
      check({ rpcUrls: ["javascript:alert(1)"] }).message,
      /not a usable/,
    );
    assert.match(
      check({ rpcUrls: ["ftp://rpc.example.com"] }).message,
      /not a usable/,
    );
    assert.match(
      check({ rpcUrls: ["ws://rpc.example.com"] }).message,
      /not a usable/,
    );
  });

  it("refuses an empty list and one that is not a list", () => {
    assert.match(check({ rpcUrls: [] }).message, /0 entries/);
    assert.match(
      check({ rpcUrls: "https://rpc.example.com" }).message,
      /a list/,
    );
  });

  it("refuses a bad entry even when the others are fine", () => {
    const bad = check({
      rpcUrls: ["https://rpc.pulsechain.com", "just some words"],
    });
    assert.match(bad.message, /just some words/);
  });
});

describe("checkConfigValues — the shapes that are not numbers", () => {
  it("refuses a boolean setting given anything but a boolean", () => {
    assert.equal(check({ moralisEnabled: false }), null);
    assert.match(check({ moralisEnabled: "yes" }).message, /on or off/);
  });

  it("accepts only the one gas strategy there is", () => {
    assert.equal(check({ gasStrategy: "auto" }), null);
    assert.match(check({ gasStrategy: "turbo" }).message, /only "auto"/);
  });

  it("takes a calendar date for the lifetime start", () => {
    assert.equal(check({ lifetimeStartDateOverrideUtc: "2026-01-31" }), null);
    assert.match(
      check({ lifetimeStartDateOverrideUtc: "last tuesday" }).message,
      /calendar date/,
    );
  });
});

describe("checkConfigValues — clearing a setting", () => {
  it("lets null through, because null is how a setting is cleared", () => {
    /*- The route deletes the key rather than storing it, so there is no
     *  value to bound. Refusing null here would make the No Override
     *  and Reset buttons 400. */
    assert.equal(check({ rebalanceRangeWidthPct: null }), null);
    assert.equal(check({ decimalsOverride0: null }), null);
    assert.equal(check({ lifetimeStartDateOverrideUtc: null }), null);
  });

  it("accepts zero for a price override, which is how that one clears", () => {
    /*- Every reader gates on `priceOverride > 0`, and the dialog sends 0
     *  to clear. A floor above zero here would strand an override the
     *  operator could set but never remove. */
    assert.equal(check({ priceOverride0: 0 }), null);
    assert.equal(check({ priceOverride1: 12.5 }), null);
    assert.match(check({ priceOverride0: -1 }).message, /zero or more/);
  });

  it("accepts zero for the deposit and the OOR timeout", () => {
    /*- Both use zero as a real setting: no deposit recorded, and the
     *  timeout switched off. */
    assert.equal(check({ initialDepositUsd: 0 }), null);
    assert.equal(check({ rebalanceTimeoutMin: 0 }), null);
  });
});

describe("checkConfigValues — the compound threshold", () => {
  it("refuses one below the fee a compound needs to be worth its gas", () => {
    const bad = check({ autoCompoundThresholdUsd: 0.5 });
    assert.equal(bad.key, "autoCompoundThresholdUsd");
    assert.match(bad.message, /\$1/);
    assert.equal(check({ autoCompoundThresholdUsd: 5 }), null);
  });

  it("treats a missing floor as no floor rather than refusing everything", () => {
    /*- The floor arrives from the caller. If that ever stops being
     *  resolvable, a threshold the operator sets must not become
     *  unsaveable. */
    assert.equal(
      checkConfigValues({ autoCompoundThresholdUsd: 0.5 }, { defaultsSec: {} }),
      null,
    );
  });
});

describe("checkConfigValues — the timer setting", () => {
  it("hands the poll interval to the timer-bounds module", () => {
    assert.equal(check({ checkIntervalSec: 300 }), null);
    const bad = check({ checkIntervalSec: 7200 });
    assert.equal(bad.key, "checkIntervalSec");
    assert.match(bad.message, /3600/);
  });

  it("refuses one below the floor too", () => {
    assert.match(check({ checkIntervalSec: 0 }).message, /at least 10/);
  });
});

describe("checkConfigValues — what it leaves alone", () => {
  it("ignores keys the dashboard does not let an operator set", () => {
    /*- `hodlBaseline`, `residuals` and the compound tallies are written
     *  by the bot, not typed. Bounding them here would refuse the app's
     *  own writes. */
    assert.equal(check({ hodlBaseline: { entryValue: 12 } }), null);
    assert.equal(check({ residuals: { amount0: "1" } }), null);
    assert.equal(check({ lastCompoundAt: 1771200000000 }), null);
  });

  it("ignores an undefined value, which means the key was not sent", () => {
    assert.equal(check({ checkIntervalSec: undefined }), null);
  });

  it("stops at the first problem and names that one", () => {
    const bad = check({ maxRebalancesPerDay: 0, gasStrategy: "turbo" });
    assert.ok(["maxRebalancesPerDay", "gasStrategy"].includes(bad.key));
  });
});

describe("every bounded key is one the app actually has", () => {
  it("names only real config keys", () => {
    /*- A rule against a key that no longer exists is a rule that never
     *  fires, and it would go on reading as coverage. */
    const known = new Set([...GLOBAL_KEYS, ...POSITION_KEYS]);
    for (const key of Object.keys(BOUNDS))
      assert.ok(known.has(key), `${key} is not a GLOBAL_KEY or POSITION_KEY`);
  });

  it("declares a min at or below the max for every range", () => {
    for (const [key, b] of Object.entries(BOUNDS)) {
      assert.equal(typeof b.min, "number", `${key} min`);
      assert.equal(typeof b.max, "number", `${key} max`);
      assert.ok(b.min <= b.max, `${key}: min ${b.min} above max ${b.max}`);
    }
  });
});
