/**
 * @file test/dashboard-param-help-coverage.test.js
 * @description
 * Pins the contract between the circle-i buttons in the markup and the
 * help content they open.
 *
 * `showParamHelp` does `if (!entry) return;` — an unknown key is a
 * silent no-op. So a typo'd or renamed `data-param-help` value ships a
 * circle-i that looks live, gets clicked, and does nothing. Lint can't
 * see it (the key is a string in an HTML attribute), and no test did
 * either until this one.
 *
 * Also guards the shipped-default bounds for the Price Range Extension
 * "Default" button, and the wording of the two fee dialogs.  Help copy
 * that contradicts what the code computes is invisible to every gate —
 * only a reader can catch it — so the claims that matter are pinned
 * here against the behaviour.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { indexHtmlDocument } = require("./helpers/index-html");

const ROOT = path.join(__dirname, "..");
const INDEX_HTML = path.join(ROOT, "public", "index.html");

/** Every `data-param-help="…"` key used in the markup. */
function markupKeys() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  return [
    ...new Set(
      [...html.matchAll(/data-param-help="([^"]+)"/g)].map((m) => m[1]),
    ),
  ];
}

/**
 * PARAM_HELP, read from the ES module.
 *
 * `param-help-content.js` is browser ES-module source with no runtime
 * dependencies, so a dynamic import reads the real object rather than a
 * re-parsed copy that could drift from what the dashboard bundles.
 */
async function paramHelp() {
  const mod = await import("../public/param-help-content.js");
  return mod.PARAM_HELP;
}

test("every data-param-help key in the markup has help content", async () => {
  const help = await paramHelp();
  const missing = markupKeys().filter((k) => !help[k]);
  assert.deepEqual(
    missing,
    [],
    `circle-i buttons with no PARAM_HELP entry (they would open nothing): ${missing.join(", ")}`,
  );
});

test("the markup actually uses param-help keys", async () => {
  /*- Without this, a regex that stopped matching would make the test
   *  above pass forever over an empty list. */
  assert.ok(markupKeys().length > 10, "expected many circle-i buttons");
});

test("every help entry is renderable — title plus real sections", async () => {
  const help = await paramHelp();
  for (const [key, entry] of Object.entries(help)) {
    assert.ok(entry.title, `${key}: needs a title`);
    assert.ok(
      Array.isArray(entry.sections) && entry.sections.length > 0,
      `${key}: needs at least one section`,
    );
    for (const s of entry.sections) {
      assert.ok(s.heading, `${key}: a section is missing its heading`);
      assert.ok(s.body, `${key}: section "${s.heading}" has no body`);
    }
  }
});

/* ---------- the two Current-panel fee dialogs ---------- */

test("Fees Earned and Fees Compounded both open a help dialog", async () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  /*- Both rows carry a circle-i wired to the shared param-help system,
   *  not a bare `title` tooltip. */
  for (const [row, key] of [
    ["pnlFees", "curFees"],
    ["pnlCompounded", "curCompounded"],
  ]) {
    const line = html
      .split("\n")
      .find(
        (l) => l.includes(`id="${row}"`) && l.includes("9mm-pos-mgr-pnl-row"),
      );
    assert.ok(line, `${row} row not found`);
    assert.match(
      line,
      new RegExp(`data-param-help="${key}"`),
      `the ${row} row must open the ${key} dialog`,
    );
  }
});

test("the Fees Earned tooltip does not claim compounded fees are included", async () => {
  /*- `feesUsd` in src/bot-pnl-updater.js is
   *  tokensOwed0*price0 + tokensOwed1*price1 — UNCLAIMED fees only,
   *  and compounding zeroes tokensOwed.  The two figures are disjoint,
   *  which is why the code adds them, so copy saying one includes the
   *  other states the opposite of what is computed. */
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.equal(
    html.includes("Includes any fees that were compounded"),
    false,
    "this wording contradicts what feesUsd computes",
  );
});

test("curFees says compounded fees are NOT included, and where they are", async () => {
  const help = await paramHelp();
  const text = help.curFees.sections.map((s) => s.body).join(" ");
  assert.match(text, /does <strong>not<\/strong> include fees compounded/i);
  assert.match(text, /line directly below/i, "points at where to find them");
});

test("both Current fee dialogs offer Re-scan Prices as the remedy", async () => {
  const help = await paramHelp();
  for (const key of ["curFees", "curCompounded"]) {
    const text = help[key].sections.map((s) => s.body).join(" ");
    assert.match(text, /Re-scan Prices/, `${key}: names the remedy`);
    assert.match(text, /gear\s+icon at top right/i, `${key}: says where`);
  }
});

test("curCompounded scopes itself to this NFT, not the whole chain", async () => {
  /*- snap.currentCompoundedUsd sums compoundHistory rows matching the
   *  CURRENT tokenId (src/bot-pnl-current-nft.js), while the Lifetime
   *  figure spans every NFT in the rebalance chain.  Conflating them
   *  would make the two panels look like they disagree. */
  const help = await paramHelp();
  const text = help.curCompounded.sections.map((s) => s.body).join(" ");
  assert.match(text, /this NFT|NFT you are looking at/i);
  assert.match(text, /Lifetime/, "points at the panel with the full figure");
});

test("the Lifetime Fees Compounded dialog gained the price-feed section", async () => {
  const help = await paramHelp();
  const sections = help.ltCompounded.sections;
  const last = sections[sections.length - 1];
  assert.equal(
    last.heading,
    "If the number looks off",
    "the new section goes after the existing last one",
  );
  assert.match(last.body, /Re-scan Prices/);
  /*- The pre-existing sections must survive the append. */
  const headings = sections.map((s) => s.heading);
  assert.ok(headings.includes("What it includes"));
  assert.ok(headings.includes("Why this figure may slightly overstate"));
});

/* ---------- shipped default for the Price Range Extension button ---------- */

test("the shipped Price Range Extension default is within its validator bounds", async () => {
  /*- The "Default" button injects this straight into the input.  A
   *  value outside 0.1..200 would be clamped elsewhere and the button
   *  would appear to do the wrong thing. */
  const shipped = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");
  const v = shipped.rebalanceRangeWidthPct;
  assert.equal(typeof v, "number");
  assert.ok(v >= 0.1 && v <= 200, `out of range: ${v}`);
});

test("the Price Range Extension default is not below the input's min", async () => {
  const shipped = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const line = html.split("\n").find((l) => l.includes('id="inRangeWidth"'));
  const min = Number(/min="([\d.]+)"/.exec(line)[1]);
  assert.ok(
    shipped.rebalanceRangeWidthPct >= min,
    `default ${shipped.rebalanceRangeWidthPct} is below the input min ${min}`,
  );
});

/* ---------- the throttle dialog, converted to a standard info-dialog ---------- */

test("the Rebalance Timing dialog opens through the shared help system", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const line = html.split("\n").find((l) => l.includes('id="throttleBadge"'));
  assert.ok(line, "the throttle section header was not found");
  assert.match(
    line,
    /data-param-help="throttleBadge"/,
    "its circle-i must use the shared param-help system",
  );
});

test("the hand-rolled throttle modal is gone, markup and wiring alike", () => {
  /*- It had its own overlay, its own two close buttons, its own
   *  show/hide handlers and its own entry in the Escape-key list — four
   *  places to keep in step for one dialog.  Leaving any of them behind
   *  would be dead code that still answers to an id. */
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.equal(html.includes('id="throttleInfoModal"'), false);
  assert.equal(html.includes('id="throttleInfoBtn"'), false);
  assert.equal(html.includes('id="throttleInfoOk"'), false);
  for (const f of ["dashboard-events.js", "dashboard-events-manage.js"]) {
    const js = fs.readFileSync(path.join(ROOT, "public", f), "utf8");
    assert.equal(
      js.includes("throttleInfo"),
      false,
      `${f} still references the removed modal`,
    );
  }
});

/* ---------- every circle-i is reachable by click ---------- */

test("every circle-i in index.html opens something on click", async () => {
  /*- A circle-i whose help lives only in a `title` is unreachable on a
   *  phone: native tooltips are hover-only, and there is no hover.  Two
   *  attempts at an anchored tap-to-show popover were both clipped —
   *  first by `overflow: hidden` on `.kpi-card`, then by the Pool
   *  Details modal's scroll area — so the app settled on one mechanism:
   *  every icon either opens a param-help dialog or has its own wired
   *  click handler.  This asserts that, so a new icon cannot ship with
   *  no click path. */
  require("global-jsdom/register");
  const doc = indexHtmlDocument();
  const icons = [...doc.querySelectorAll(".\\39mm-pos-mgr-il-info-btn")];
  assert.ok(icons.length > 30, "selector should match the app's ~44 icons");

  /*- Ids dashboard-events.js wires a click to, read from source rather
   *  than hardcoded so rewiring cannot silently invalidate the list. */
  const events = fs.readFileSync(
    path.join(ROOT, "public", "dashboard-events.js"),
    "utf8",
  );
  const wired = new Set(
    [...events.matchAll(/_click\("([A-Za-z0-9_]+)"/g)].map((m) => m[1]),
  );

  const orphans = icons
    .filter((el) => !el.hasAttribute("data-param-help") && !wired.has(el.id))
    .map((el) => el.id || (el.getAttribute("title") || "").slice(0, 60));
  assert.deepEqual(
    orphans,
    [],
    "these circle-i icons have no click path — unreachable on touch",
  );
});

test("the throttle help keeps a section for every badge state", async () => {
  /*- A state with no explanation is a user staring at a word with
   *  nowhere to look it up.  These six are exactly what
   *  `_renderThrottleBadge` in dashboard-throttle.js can paint; keep
   *  the two lists in step.  The trailing section is not a badge
   *  state — it explains that the ladder is first-match, which is why
   *  a pool at 4 of 5 can read THROTTLED instead of NEAR LIMIT. */
  const help = await paramHelp();
  const headings = help.throttleBadge.sections.map((s) => s.heading);
  assert.deepEqual(headings, [
    "OK",
    "THROTTLED",
    "DOUBLING",
    "NEAR LIMIT",
    "CAPPED",
    "N/A",
    "Only one shows at a time",
  ]);
});

test("every badge state the code can paint has a help section", async () => {
  /*- Derived rather than hardcoded, so adding a state to the renderer
   *  without adding copy trips here.  The previous version of this file
   *  asserted a fixed list that had silently drifted: the renderer grew
   *  NEAR LIMIT and N/A while the help kept four sections. */
  const src = fs.readFileSync(
    path.join(ROOT, "public", "dashboard-throttle.js"),
    "utf8",
  );
  const fn = src.slice(
    src.indexOf("function _renderThrottleBadge"),
    src.indexOf("function _checkBannerVisibility"),
  );
  /*- Badge labels are the string literals assigned to textContent, plus
   *  the "N/A" that `_renderNa` writes for unmanaged positions (that
   *  helper sits outside this slice).  The match deliberately does NOT
   *  require a closing quote: DOUBLING is built by concatenation
   *  ("DOUBLING \u00D7" + n), so anchoring on the quote silently
   *  dropped it and left this assertion blind to one whole state. */
  const painted = new Set(["N/A"]);
  for (const m of fn.matchAll(/textContent = "([A-Z/ ]+)/g))
    painted.add(m[1].trim());
  const documented = new Set(
    (await paramHelp()).throttleBadge.sections.map((s) => s.heading),
  );
  for (const state of painted)
    assert.ok(
      documented.has(state),
      `badge can paint "${state}" but the help has no section for it`,
    );
});

test("the throttle copy survived the move verbatim in substance", async () => {
  const help = await paramHelp();
  const body = help.throttleBadge.sections.map((s) => s.body).join(" ");
  assert.match(body, /free to rebalance/);
  assert.match(body, /Min Time Between Rebalances/);
  assert.match(body, /10m &rarr; 20m &rarr; 40m &rarr; 80m/);
  assert.match(body, /Max Rebalances \/ Day/);
  assert.match(body, /midnight UTC/);
});

/* ---------- per-token slippage labels ---------- */

test("each slippage row names the swap direction it governs", async () => {
  /*- "Slippage (HEX)" left it ambiguous whether the tolerance applied
   *  when buying that token or selling it. */
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  for (const n of [0, 1]) {
    assert.match(
      html,
      new RegExp(
        `Slippage When Swapping to Token ${n} \\(<span id="slipT${n}Name">`,
      ),
      `token ${n}'s label must state the direction`,
    );
  }
});

test("the slippage labels keep their live token-symbol span", async () => {
  /*- The parenthetical is filled in with the pool's real symbol at
   *  runtime; dropping the span would freeze it at "Token 0". */
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.match(html, /<span id="slipT0Name">Token 0<\/span>\)/);
  assert.match(html, /<span id="slipT1Name">Token 1<\/span>\)/);
});

test("no section heading carries an HTML entity", async () => {
  /*-
   *  `dashboard-param-help.js` sets a heading with `textContent` and
   *  only the body with `innerHTML`. An entity in a heading therefore
   *  reaches the screen as the literal characters "&rsquo;" rather than
   *  an apostrophe — visible to a reader, invisible to every gate.
   *
   *  Bodies are deliberately exempt: rich text there is the point.
   */
  const help = await paramHelp();
  const offenders = [];
  for (const [key, entry] of Object.entries(help))
    for (const s of entry.sections || [])
      if (/&[a-zA-Z]+;|&#\d+;/.test(s.heading || ""))
        offenders.push(`${key}: ${s.heading}`);
  assert.deepEqual(
    offenders,
    [],
    "headings are plain text — use the character itself, not an entity",
  );
});
