"use strict";

/**
 * @file test/env-reads-through-readenv.test.js
 * @description Every variable `ENV_SETTINGS` names is read through
 *   `readEnv` (src/lib/env-settings.js), so a blank value sets nothing and
 *   a wrong one is refused by its rule. No module under src/ reads one
 *   straight from `process.env`, but the three that cannot (CLAUDE.md,
 *   "Every setting is checked before the app starts"): the two settings
 *   folders, which src/lib/load-merged-defaults.js reads before the rules
 *   exist, since env-settings is built on that loader; and CHAIN_NAME,
 *   which src/lib/runtime-flags.js reads by its own rule
 *   (`resolveChainName`).
 *
 *   Comment lines are skipped, so a comment may name a variable as it
 *   is set in the environment.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ENV_SETTINGS } = require("../src/lib/env-settings");

const SRC = path.join(__dirname, "..", "src");

// The reads allowed, by file under src/, and why each cannot use readEnv.
const ALLOWED = {
  "lib/load-merged-defaults.js": [
    "LP_RANGER_DEFAULTS_DIR",
    "LP_RANGER_USER_CONFIG_DIR",
  ],
  "lib/runtime-flags.js": ["CHAIN_NAME"],
};

/** Every .js file under `dir`, named by its path under src/. */
function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/**
 * Each raw read of a registered variable in `src`'s code lines: the
 * variable and the line number.
 * @param {string} src
 * @returns {{name: string, line: number}[]}
 */
function rawReads(src) {
  const reads = [];
  src.split("\n").forEach((text, i) => {
    const t = text.trim();
    if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
    const found = text.matchAll(
      /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\])/g,
    );
    for (const m of found) {
      const name = m[1] ?? m[2];
      if (name in ENV_SETTINGS) reads.push({ name, line: i + 1 });
    }
  });
  return reads;
}

describe("reading a variable ENV_SETTINGS names", () => {
  it("goes through readEnv everywhere under src/ but the allowed three", () => {
    const strays = [];
    for (const file of jsFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      const allowed = ALLOWED[rel] ?? [];
      for (const r of rawReads(fs.readFileSync(file, "utf8")))
        if (!allowed.includes(r.name))
          strays.push(`src/${rel}:${r.line} reads process.env.${r.name}`);
    }
    assert.deepEqual(
      strays,
      [],
      `read these through readEnv (src/lib/env-settings.js):\n${strays.join("\n")}`,
    );
  });

  it("finds a raw read, in either form, and skips a comment", () => {
    /*-
     *  Guards the guard: a matcher that found nothing would pass the case
     *  above whatever src/ holds.
     */
    const code = [
      "const a = process.env.PRICE_CACHE_PATH;",
      'const b = process.env["LOG_FILE"];',
      " * Read `process.env.DRY_RUN` here.",
      "const c = process.env.NODE_TEST_CONTEXT;",
    ].join("\n");
    assert.deepEqual(rawReads(code), [
      { name: "PRICE_CACHE_PATH", line: 1 },
      { name: "LOG_FILE", line: 2 },
    ]);
  });

  it("keeps the allowed list honest", () => {
    // An allowance for a read that is gone is dead weight.
    for (const [rel, names] of Object.entries(ALLOWED)) {
      const found = rawReads(
        fs.readFileSync(path.join(SRC, ...rel.split("/")), "utf8"),
      ).map((r) => r.name);
      for (const name of names)
        assert.ok(
          found.includes(name),
          `src/${rel} does not read ${name}: drop its allowance`,
        );
    }
  });
});
