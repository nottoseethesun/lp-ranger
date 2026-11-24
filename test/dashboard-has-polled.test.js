"use strict";

/**
 * @file test/dashboard-has-polled.test.js
 * @description How long the bot gives the dashboard to see a change
 *   (src/bot/dashboard-has-polled.js): the dashboard's poll interval in
 *   force times app-runtime.json → dashboard.pollsBeforeAssumedSeen, each
 *   with the operator's copy over it, and a multiple outside its range
 *   refused, naming it. Each case reads the settings afresh against
 *   overrides of its own, through test/helpers/config-with-overrides.js.
 */

// Required first: it points the settings folder at its own, before src/lib/ loads.
const { loadConfigWith } = require("./helpers/config-with-overrides");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const _UI_SERVER_UP = "ui-defaults_non-layout_for-server-up-scenario.json";
const _MODULE = "../src/bot/dashboard-has-polled";

/** The bot's figure, with `overrides` as the operator's files. */
function figureWith(overrides) {
  loadConfigWith(overrides);
  delete require.cache[require.resolve(_MODULE)];
  return require(_MODULE).guaranteedDashboardHasPolledMs();
}

describe("how long the dashboard is given to see a change", () => {
  it("is the poll interval in force times pollsBeforeAssumedSeen, each an override", () => {
    assert.equal(
      figureWith({
        [_UI_SERVER_UP]: { dashboardPollIntervalMs: 4000 },
        "app-runtime.json": { dashboard: { pollsBeforeAssumedSeen: 3.5 } },
      }),
      14000,
    );
  });

  for (const bad of [0.5, 101, "2", null]) {
    it(`refuses pollsBeforeAssumedSeen = ${JSON.stringify(bad)}, naming it`, () => {
      assert.throws(
        () =>
          figureWith({
            "app-runtime.json": { dashboard: { pollsBeforeAssumedSeen: bad } },
          }),
        /app-runtime\.json → dashboard\.pollsBeforeAssumedSeen must be/,
      );
    });
  }
});
