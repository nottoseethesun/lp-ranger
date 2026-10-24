"use strict";

/**
 * @file test/il-guard.test.js
 * @description Tests for the Impermanent Loss Guard's RULES — the pure
 * decisions in `src/lib/il-guard.js`, plus its shipped defaults and the
 * Telegram message.  The gate that applies them to a poll cycle is
 * tested in `il-guard-gate.test.js`; the two files split when this one
 * passed the 500-line cap.
 *
 * The guard rejects a rebalance when the hypothetical post-rebalance
 * position would sit more than `impermanentLossGuardPct` below holding
 * the coins the NFT currently held was minted with, at today's prices.
 * How those two are worked out from a poll is tested in
 * `il-guard-holding.test.js`.
 *
 * The property that matters most here: an impermanent GAIN can never
 * block.  A position worth more than holding is above the floor for any
 * setting in 1..100, so the rare gain case must always pass.
 */

const { describe, it } = require("node:test");
const { ilSnapshot } = require("./helpers/il-snapshot");
const assert = require("node:assert/strict");

const {
  _ilGuardMessage,
  MANUAL_URL,
  evaluateIlGuard,
  ilGuardInputs,
  ilGuardRetryWaitMs,
  checkIlGuard,
} = require("../src/lib/il-guard");
const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
const config = require("../src/lib/config");
const { SETTING_BOUNDS } = require("../src/lib/setting-bounds");
const {
  fillEntryFigures,
  spanFigureTokens,
} = require("../src/lib/help-figures");
const { render, shippedFigures } = require("../scripts/build-manual-content");

const _SHIPPED_ALL = readBotConfigDefaults();
const SHIPPED = _SHIPPED_ALL.impermanentLossGuardPct;
const SHIPPED_RETRY = _SHIPPED_ALL.ilGuardRetry;

describe("evaluateIlGuard — the rule", () => {
  it("rejects when the projection falls below the floor", () => {
    // Holding worth $1,000, a 50% guard: floor $500.  $480 is under it.
    const r = evaluateIlGuard({
      projectedValueUsd: 480,
      holdValueUsd: 1000,
      guardPct: 50,
    });
    assert.equal(r.evaluated, true);
    assert.equal(r.rejected, true);
    assert.equal(r.floorUsd, 500);
    assert.equal(Math.round(r.lossPct), 52);
  });

  it("allows when the projection is above the floor", () => {
    const r = evaluateIlGuard({
      projectedValueUsd: 640,
      holdValueUsd: 1000,
      guardPct: 50,
    });
    assert.equal(r.rejected, false);
  });

  it("allows exactly at the floor", () => {
    /*- "more than this far below" — the boundary itself is not a
     *  rejection, so the comparison is strict. */
    const r = evaluateIlGuard({
      projectedValueUsd: 500,
      holdValueUsd: 1000,
      guardPct: 50,
    });
    assert.equal(r.rejected, false);
  });

  it("a tighter guard rejects what a looser one allows", () => {
    const at = (guardPct) =>
      evaluateIlGuard({
        projectedValueUsd: 700,
        holdValueUsd: 1000,
        guardPct,
      }).rejected;
    assert.equal(at(50), false, "30% down passes a 50% guard");
    assert.equal(at(20), true, "the same position fails a 20% guard");
  });

  it("100 effectively turns it off", () => {
    const r = evaluateIlGuard({
      projectedValueUsd: 0.01,
      holdValueUsd: 1000,
      guardPct: 100,
    });
    assert.equal(r.rejected, false, "floor is $0 — nothing is below it");
  });
});

describe("evaluateIlGuard — impermanent GAIN never rejects", () => {
  /*- The case the user asked to be proven.  A gain is above the floor by
   *  construction, so no setting in range can block it. */

  it("a position worth more than holding always passes", () => {
    for (let guardPct = 1; guardPct <= 100; guardPct++) {
      const r = evaluateIlGuard({
        projectedValueUsd: 1961.45,
        holdValueUsd: 1252.07,
        guardPct,
      });
      assert.equal(
        r.rejected,
        false,
        `a +56% position must not be rejected at guardPct=${guardPct}`,
      );
    }
  });

  it("a position worth exactly what holding is worth always passes", () => {
    for (const guardPct of [1, 20, 50, 99, 100]) {
      assert.equal(
        evaluateIlGuard({
          projectedValueUsd: 1000,
          holdValueUsd: 1000,
          guardPct,
        }).rejected,
        false,
      );
    }
  });

  it("a gain reports a negative loss percentage, not a rejection", () => {
    const r = evaluateIlGuard({
      projectedValueUsd: 1200,
      holdValueUsd: 1000,
      guardPct: 50,
    });
    assert.equal(r.rejected, false);
    assert.equal(r.lossPct, -20, "a 20% gain reads as -20% loss");
  });
});

describe("evaluateIlGuard — fails open", () => {
  /*- The guard is a brake on a losing position, not a safety interlock.
   *  Freezing the bot because a figure has not finished loading would do
   *  more harm than the case it protects against. */

  it("allows when what holding is worth is not known yet", () => {
    for (const holdValueUsd of [undefined, null, 0, NaN, -1]) {
      const r = evaluateIlGuard({
        projectedValueUsd: 1,
        holdValueUsd,
        guardPct: 50,
      });
      assert.equal(r.rejected, false);
      assert.equal(r.evaluated, false);
      assert.equal(r.reason, "no-hold-value");
    }
  });

  it("allows when the projection is unusable", () => {
    for (const projectedValueUsd of [undefined, null, NaN, -5]) {
      const r = evaluateIlGuard({
        projectedValueUsd,
        holdValueUsd: 1000,
        guardPct: 50,
      });
      assert.equal(r.rejected, false);
      assert.equal(r.reason, "no-projected-value");
    }
  });

  it("allows when the guard percentage is missing or out of range", () => {
    for (const guardPct of [undefined, null, 0, -1, 101, NaN, "50"]) {
      const r = evaluateIlGuard({
        projectedValueUsd: 1,
        holdValueUsd: 1000,
        guardPct,
      });
      assert.equal(r.rejected, false);
      assert.equal(r.reason, "guard-not-set");
    }
  });

  it("a projection of exactly zero is still measured, not waved through", () => {
    /*- A worthless position is the clearest possible rejection; it must
     *  not be mistaken for missing data. */
    const r = evaluateIlGuard({
      projectedValueUsd: 0,
      holdValueUsd: 1000,
      guardPct: 50,
    });
    assert.equal(r.evaluated, true);
    assert.equal(r.rejected, true);
  });
});

describe("ilGuardInputs", () => {
  it("values the minted coins at the prices IL/G was measured with", () => {
    /*-
     *  500 of each coin, at $0.60 and $0.80 today: $700, whatever the
     *  coins were worth on the day they were minted.
     */
    const r = ilGuardInputs({
      totalIL: -10,
      ilInputs: {
        price0: 0.6,
        price1: 0.8,
        cur: { hodlAmount0: 500, hodlAmount1: 500 },
      },
    });
    assert.equal(r.holdValueUsd, 700);
  });

  it("projects holding plus the panel's IL/G", () => {
    // $10 of impermanent loss against $700 of holding.
    const r = ilGuardInputs(ilSnapshot(690, 700));
    assert.equal(r.projectedValueUsd, 690);
  });

  it("returns nulls until the snapshot carries IL/G", () => {
    /*-
     *  No minted coins read yet: `_computeIL` leaves `totalIL` undefined,
     *  which the dashboard shows as a dash.
     */
    for (const snap of [
      null,
      undefined,
      {},
      { totalIL: undefined, ilInputs: { cur: {} } },
      { totalIL: -10 },
    ]) {
      const r = ilGuardInputs(snap);
      assert.equal(r.projectedValueUsd, null, JSON.stringify(snap));
      assert.equal(r.holdValueUsd, null, JSON.stringify(snap));
    }
  });
});

describe("ilGuardRetryWaitMs — the backoff ladder", () => {
  /*- 4 h, doubling per consecutive rejection, held at one week.  Driving
   *  this through eight real waits is not an option, so the ladder is
   *  pinned directly. */
  const H = 3_600_000;

  it("climbs 4h, 8h, 16h, 32h, 64h, 128h and then holds at a week", () => {
    const hours = [1, 2, 3, 4, 5, 6, 7, 8].map(
      (n) => ilGuardRetryWaitMs(n) / H,
    );
    assert.deepEqual(hours, [4, 8, 16, 32, 64, 128, 168, 168]);
  });

  it("treats a first rejection and an unset counter the same", () => {
    /*- The counter is incremented as the rejection is recorded, so the
     *  first backoff is computed from 0 in one path and 1 in another. */
    assert.equal(ilGuardRetryWaitMs(0), 4 * H);
    assert.equal(ilGuardRetryWaitMs(1), 4 * H);
    assert.equal(ilGuardRetryWaitMs(undefined), 4 * H);
  });

  it("never exceeds the ceiling, however long the block runs", () => {
    /*- 2 ** (n - 1) overflows to Infinity well before this; the cap must
     *  still be a number. */
    for (const n of [50, 1000, Number.MAX_SAFE_INTEGER])
      assert.equal(ilGuardRetryWaitMs(n), 168 * H);
  });

  it("honours an operator override of the group", () => {
    /*- Tunable through the layered defaults file only, like
     *  residualCleanup — not per position. */
    const over = { baseMs: 60_000, maxMs: 240_000 };
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => ilGuardRetryWaitMs(n, over) / 60_000),
      [1, 2, 4, 4, 4],
      "one minute doubling, capped at four",
    );
  });
});

describe("the Telegram message", () => {
  /*- Deliberately short and link-out rather than a mirror of the info
   *  dialog.  Rendering every dialog section into the alert measured
   *  4086 characters against a worst-case header — a 10-character
   *  margin under Telegram's 4096 cap, which a longer token pair or
   *  hostname would silently blow. */
  const FIGURES = {
    projectedValueUsd: 2788.65,
    holdValueUsd: 3947.23,
    guardPct: 50,
    floorUsd: 1973.62,
    lossPct: 29.4,
    nextCheckHours: "4",
  };
  const msg = () => _ilGuardMessage(FIGURES, { link: true });

  /*- A generous stand-in for `buildHeader`: long hostname, chain name,
   *  provider, two 16-char symbols, fee tier and token id. */
  const WORST_HEADER = 599;
  const TELEGRAM_LIMIT = 4096;

  it("stays under 200 words", () => {
    const words = msg().trim().split(/\s+/).length;
    assert.ok(words <= 200, `message is ${words} words`);
  });

  it("fits Telegram's limit even with a worst-case header", () => {
    const total = msg().length + WORST_HEADER;
    assert.ok(
      total < TELEGRAM_LIMIT,
      `message + header is ${total} of ${TELEGRAM_LIMIT}`,
    );
  });

  it("carries the numbers a reader needs without a dashboard", () => {
    const m = msg();
    for (const s of [
      "$usd 2788.65",
      "$usd 3947.23",
      "29.4%",
      "50%",
      "$usd 1973.62",
      "4 hours",
    ])
      assert.ok(m.includes(s), `missing ${s}`);
  });

  it("names the higher Guard, not a lower one, as what lowers the floor", () => {
    const m = msg();
    assert.match(m, /Raising the Guard/);
    assert.doesNotMatch(m, /lower the Guard/);
  });

  it("links to the manual entry for the full explanation", () => {
    assert.ok(msg().includes(MANUAL_URL));
    assert.match(MANUAL_URL, /^https:\/\/[^\s]+#il-guard$/);
  });

  it("omits the link for the dashboard, keeping every other word", () => {
    /*- The modal renders this same string, so the two channels cannot
     *  word one rejection differently.  Only the trailing link differs:
     *  a bare URL is not clickable in the modal, which has the circle-i
     *  beside the setting instead. */
    const forUi = _ilGuardMessage(FIGURES);
    assert.ok(!forUi.includes(MANUAL_URL), "no bare URL in the modal");
    assert.ok(msg().startsWith(forUi), "identical up to the link");
  });

  it("is what the dashboard is actually handed on a rejection", () => {
    /*- Pins the wiring, not just the function: were `_publishBlocked`
     *  to compose its own wording, this is the test that would fail. */
    const published = [];
    checkIlGuard(
      {
        _botState: {},
        updateBotState: (patch) => published.push(patch),
        position: { tokenId: "1", liquidity: "1000" },
      },
      false,
      ilSnapshot(100, 1000),
      () => ({}),
    );
    const message = published.at(-1)?.ilGuardBlocked?.message;
    assert.equal(typeof message, "string");
    assert.ok(!message.includes(MANUAL_URL));
    assert.ok(message.includes("$usd 100.00"), message);
  });

  it("points at an anchor the manual actually defines", () => {
    /*- A link to a missing anchor lands the reader at the top of a long
     *  page with no idea which section was meant. */
    const fs = require("node:fs");
    const path = require("node:path");
    const html = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "src",
        "client",
        "web",
        "help-and-user-manual.html",
      ),
      "utf8",
    );
    const anchor = MANUAL_URL.split("#")[1];
    assert.ok(
      html.includes(`id="${anchor}"`),
      `help-and-user-manual.html has no id="${anchor}"`,
    );
  });

  it("says the position was not touched", () => {
    /*- The single most important reassurance in the message. */
    assert.match(msg(), /not touched/);
  });
});

describe("the shipped defaults", () => {
  it("first retries a rejected position after four hours", () => {
    assert.equal(SHIPPED_RETRY.baseMs, 4 * 3_600_000);
  });

  it("stops widening the wait at one week", () => {
    assert.equal(SHIPPED_RETRY.maxMs, 7 * 24 * 3_600_000);
  });

  it("holds the guard to 1 to 100, in setting-bounds.json", () => {
    assert.equal(SETTING_BOUNDS.impermanentLossGuardPct.min, 1);
    assert.equal(SETTING_BOUNDS.impermanentLossGuardPct.max, 100);
  });

  it("the guard's own bounds check agrees with them", () => {
    /*- `evaluateIlGuard` fails open outside the bounds, so the same pair
     *  that gates the input also gates the rule.  A guardPct the
     *  normalizer would have rejected must not silently change
     *  behaviour if one ever reached the gate. */
    const at = (guardPct) =>
      evaluateIlGuard({
        projectedValueUsd: 1,
        holdValueUsd: 1000,
        guardPct,
      });
    const { min, max } = SETTING_BOUNDS.impermanentLossGuardPct;
    assert.equal(at(min).evaluated, true);
    assert.equal(at(max).evaluated, true);
    assert.equal(at(0).reason, "guard-not-set", "below the floor: no guard");
    assert.equal(at(101).reason, "guard-not-set", "above the ceiling");
  });

  it("keeps the bounds out of the markup", () => {
    /*- feedback_no_data_in_presentation: the pair is data and lives in
     *  bot-config-defaults.json; dashboard-init.js stamps it onto the
     *  input.  A literal min/max here would be a second source that
     *  silently drifts from the server-side clamp. */
    const fs = require("node:fs");
    const path = require("node:path");
    const html = fs.readFileSync(
      path.join(__dirname, "..", "src", "client", "web", "index.html"),
      "utf8",
    );
    const tag = html.match(/<input[^>]*id="inIlGuard"[^>]*>/);
    assert.ok(tag, "the Impermanent Loss Guard input exists");
    assert.ok(!/\bmin=/.test(tag[0]), "no literal min in the markup");
    assert.ok(!/\bmax=/.test(tag[0]), "no literal max in the markup");
  });

  it("honours a per-install override of the tunables", () => {
    /*- `il-guard.js` reads through `readBotConfigDefaults`, which merges
     *  `app-config/user-configurable/bot-config-defaults.json` on top of
     *  the shipped file and clamps the result — the same path
     *  gas-monitor and bot-cycle-residual use for their own groups.
     *  Reading via `loadShippedDefaults` instead would silently ignore
     *  an operator's override while the docs promised it worked. */
    const merged = readBotConfigDefaults();
    assert.equal(typeof merged.impermanentLossGuardPct, "number");
    assert.equal(typeof merged.ilGuardRetry.baseMs, "number");
    assert.equal(typeof merged.ilGuardRetry.maxMs, "number");
  });

  it("is 15 — tight, because a rebalance crystallizes the loss", () => {
    /*- The two sides of the trade are not alike.  Rebalancing re-mints
     *  around the current price, so a paper loss a recovery would have
     *  undone becomes permanent.  Declining forgoes fees the position is
     *  largely not earning, since the guard is only consulted when a
     *  rebalance was due and that usually means out of range — and fees
     *  are the only thing that earns such a loss back, which a
     *  low-volume pool may never produce fast enough. */
    assert.equal(SHIPPED, 15);
  });

  it("rejects a position that has more than halved", () => {
    assert.equal(
      evaluateIlGuard({
        projectedValueUsd: 400,
        holdValueUsd: 1000,
        guardPct: SHIPPED,
      }).rejected,
      true,
    );
  });

  it("rejects a 29.4% impermanent loss, which the old 50 default allowed", () => {
    /*-
     *  What tightening buys and costs. Bought: that 29.4% stays a paper
     *  loss a recovery can still undo. Cost: the position sits out of
     *  range earning nothing until the price returns or the operator
     *  raises the guard.
     */

    const at = (guardPct) =>
      evaluateIlGuard({
        projectedValueUsd: 2788.65,
        holdValueUsd: 3947.23,
        guardPct,
      }).rejected;
    assert.equal(at(SHIPPED), true);
    assert.equal(at(50), false, "the old default let this one through");
  });
});

/* ---------- shared help copy ---------- */

describe("the help copy is written once", () => {
  /*- The dialog and the User Manual both render the Impermanent Loss
   *  Guard explanation.  Two hand-written copies drift: the manual said
   *  "the bot keeps checking every poll" for a while after the backoff
   *  landed, because only the dialog had been updated.  Both now read
   *  `src/lib/shared-help-content.json`, and these pin that. */
  const fs = require("node:fs");
  const path = require("node:path");
  const ROOT = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const shared = () => JSON.parse(read("src/lib/shared-help-content.json"));

  it("the dialog imports the JSON rather than restating it", () => {
    const src = read("src/client/web/param-help-content.js");
    assert.match(
      src,
      /import SHARED_HELP from "\.\.\/\.\.\/lib\/shared-help-content\.json"/,
    );
    assert.match(src, /fillEntryFigures\(SHARED_HELP\.inIlGuard, f\)/);
    assert.ok(
      !/inIlGuard: \{/.test(src),
      "no inline inIlGuard entry should remain",
    );
  });

  it("every section of the JSON reaches the manual verbatim", () => {
    /*-
     *  Body text is emitted as-is once its figures are filled, each in
     *  the span the served manual refills, so a section that silently
     *  failed to render would leave the manual short without any error.
     */
    const html = read("src/client/web/help-and-user-manual.html");
    const entry = fillEntryFigures(
      shared().inIlGuard,
      shippedFigures(),
      spanFigureTokens,
    );
    assert.ok(entry.sections.length > 0);
    for (const s of entry.sections) {
      assert.ok(
        html.includes(`<h3>${s.heading}</h3>`),
        `manual is missing section "${s.heading}"`,
      );
      assert.ok(
        html.includes(s.body),
        `manual body drifted for section "${s.heading}"`,
      );
    }
  });

  it("the generated region is regenerated, not hand-edited", () => {
    /*- Re-running the generator must be a no-op.  If it is not, someone
     *  edited inside the markers and the next build would silently
     *  revert them.
     *
     *  Computed in memory rather than by calling `build()`: that writes
     *  `src/client/web/help-and-user-manual.html`, and a test must never mutate
     *  a tracked source file (CLAUDE-BEST-PRACTICES "Test Isolation" —
     *  and `check.js`'s backup pass covers app-config/ and app-data/,
     *  not src/client/web/). */
    const html = read("src/client/web/help-and-user-manual.html");
    /*-
     *  The generator's own in-memory render, imported rather than
     *  re-expressed, so the two cannot disagree about what the build
     *  writes.
     */
    const expected = render(html, shared(), shippedFigures());
    assert.equal(expected, html, "manual has hand edits inside the markers");
  });

  it("the manual anchor matches the one the Telegram link uses", () => {
    assert.equal(shared().inIlGuard.manualAnchor, MANUAL_URL.split("#")[1]);
  });
});

describe("the badge figure is the figure the bot enforces", () => {
  /*- The Auto-Rebalance Settings badge and the guard itself must read
   *  the same expression.  They did not at first: the badge went
   *  through config.IMPERMANENT_LOSS_GUARD_PCT while il-guard read
   *  bot-config-defaults.json directly, so IMPERMANENT_LOSS_GUARD_PCT=30
   *  displayed 30 while the bot still enforced 50 — the UI misreporting
   *  the threshold that decides whether a rebalance happens. */
  it("falls back to the shipped default with no env override", () => {
    assert.equal(config.IMPERMANENT_LOSS_GUARD_PCT, SHIPPED);
  });

  it("is what the bot actually enforces with nothing saved", () => {
    /*- A position one cent under the published floor must be refused
     *  and one cent over it allowed, so the badge figure is the figure
     *  in force rather than a number published beside it. */
    const floor = 1000 * (1 - config.IMPERMANENT_LOSS_GUARD_PCT / 100);
    const gate = (positionUsd) =>
      checkIlGuard(
        {
          _botState: {},
          updateBotState: () => {},
          position: { tokenId: "1", liquidity: "1000" },
        },
        false,
        ilSnapshot(positionUsd, 1000),
        () => ({}),
      );
    assert.equal(gate(floor - 0.01)?.ilGuardRejected, true);
    assert.equal(gate(floor + 0.01), null);
  });

  it("moves badge and enforcement together under an env override", () => {
    /*-
     *  Env-over-JSON is this project's layering (see the src/lib/config.js
     *  header) — the point is not that the env var is ignored, but that
     *  it can never move one of these without the other.  Checked in a
     *  child process because config.js resolves once, at require time.
     *
     *  $usd 750 against $usd 1000 of holding discriminates the two: it
     *  sits below the shipped 15% floor ($usd 850) and above the
     *  overridden 30% floor ($usd 700). The bot enforcing the shipped
     *  figure while the badge read 30 would reject it.
     */
    const { execFileSync } = require("node:child_process");
    const snap = JSON.stringify(ilSnapshot(750, 1000));
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        'const c=require("./src/lib/config"),g=require("./src/lib/il-guard");' +
          "const r=g.checkIlGuard({_botState:{}," +
          "updateBotState:()=>{},position:{tokenId:'1',liquidity:'1000'}},false," +
          `${snap},()=>({}));` +
          "process.stdout.write(String(c.IMPERMANENT_LOSS_GUARD_PCT)+" +
          '","+String(!!r&&r.ilGuardRejected===true))',
      ],
      {
        cwd: require("node:path").join(__dirname, ".."),
        env: { ...process.env, IMPERMANENT_LOSS_GUARD_PCT: "30" },
        encoding: "utf8",
      },
    );
    /*-
     *  Last line only: the child's logger shares stdout, so anything it
     *  logs precedes the value we asked for.
     */
    const [badge, rejected] = out.trim().split("\n").pop().split(",");
    assert.equal(badge, "30", "badge must show the override");
    assert.equal(rejected, "false", "and the bot must enforce it");
  });
});
