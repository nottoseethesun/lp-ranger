"use strict";

/**
 * @file test/shipped-env-example-values.test.js
 * @description `.env.example`, the `.env` an install starts from, sets
 *   only variables LP Ranger reads, each to a value its rule accepts; and
 *   every environment variable the app reads has a rule, and every rule a
 *   variable the app reads.
 *
 *   The rules are src/lib/env-settings.js, the ones the server and the bot
 *   hold an install's own `.env` to at startup. Only what ships is read,
 *   so this test passes or fails alike on every machine; an operator's
 *   `.env` is checked by the
 *   `validate-config-values-with-any-user-overrides` diagnostic. Run with
 *   the shipped-values tests, before the rest of the suite.
 *
 *   The override directory is pointed at an empty one of this file's own,
 *   so the settings the variables are judged against are the shipped ones.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shipped-env-"));
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const { loadShippedDefaults } = require("../src/lib/load-merged-defaults");
const {
  ENV_SETTINGS,
  envProblems,
  envFileProblems,
} = require("../src/lib/env-settings");

const ROOT = path.join(__dirname, "..");
const EXAMPLE = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");

/*-
 *  Read by the app, and no setting: node's test runner sets it in every
 *  test process, which is what points bot-config.json at a test's own
 *  folder (src/lib/bot-config-v2.js).
 */
const NOT_SETTINGS = new Set(["NODE_TEST_CONTEXT"]);

/** Every file the app runs: all of src/, its two entry points included. */
function appFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  walk(path.join(ROOT, "src"));
  return out;
}

/** Every file of LP Ranger's own tools: scripts/ and util/, tests aside. */
function toolFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p !== path.join(ROOT, "util", "test")) walk(p);
      } else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  walk(path.join(ROOT, "scripts"));
  walk(path.join(ROOT, "util"));
  return out;
}

const source = (f) => ({
  file: path.relative(ROOT, f),
  text: fs.readFileSync(f, "utf8"),
});
const SOURCES = appFiles().map(source);
const TOOL_SOURCES = toolFiles().map(source);

describe(".env.example", () => {
  it("sets only variables LP Ranger reads, each on a NAME=value line", () => {
    assert.deepEqual(envFileProblems(EXAMPLE), []);
  });

  it("sets each to a value its rule accepts", () => {
    const ctx = {
      chains: loadShippedDefaults("chains.json"),
      appRuntime: loadShippedDefaults("app-runtime.json"),
      botDefaults: loadShippedDefaults("bot-config-defaults.json"),
    };
    assert.deepEqual(envProblems(dotenv.parse(EXAMPLE), ctx), []);
  });

  it("names only variables LP Ranger reads, commented-out ones included", () => {
    const named = [...EXAMPLE.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(
      (m) => m[1],
    );
    assert.ok(named.length > 0, "the example names variables");
    for (const name of named)
      assert.ok(Object.hasOwn(ENV_SETTINGS, name), `${name} has no rule`);
  });
});

describe("every environment variable the app reads", () => {
  it("has a rule in src/lib/env-settings.js", () => {
    for (const { file, text } of SOURCES)
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g))
        assert.ok(
          Object.hasOwn(ENV_SETTINGS, m[1]) || NOT_SETTINGS.has(m[1]),
          `${file} reads ${m[1]}, which has no rule in src/lib/env-settings.js`,
        );
  });

  it("and every rule is for a variable the app or one of its tools reads", () => {
    /*-
     *  A variable only a tool reads, such as `npm run debug-attach`'s
     *  INSPECTOR_PORT, is still LP Ranger's, so `.env` may hold it.
     */
    const others = [...SOURCES, ...TOOL_SOURCES].filter(
      (s) => s.file !== "src/lib/env-settings.js",
    );
    for (const name of Object.keys(ENV_SETTINGS))
      assert.ok(
        others.some(
          ({ text }) =>
            text.includes(`"${name}"`) || text.includes(`process.env.${name}`),
        ),
        `${name} has a rule, but nothing reads it`,
      );
  });
});
