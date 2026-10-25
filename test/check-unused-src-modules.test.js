/**
 * @file test/check-unused-src-modules.test.js
 * @description The gate that fails when a module under `src/` is loaded by
 *   no part of the app (scripts/check-unused-src-modules.js): the entry
 *   points it starts from, tests left out, and the walk from them, which
 *   follows `require` and `import` alike. Each case builds a small sample
 *   project in a temp folder; the last reads this project's own file list
 *   from git.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  checkUnusedSrcModules,
  appEntryFiles,
  srcModuleFiles,
  nodeTargets,
} = require("../scripts/check-unused-src-modules");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

/**
 * A sample project in a temp folder of its own.
 * @param {Record<string, string>} files  Each file's text, by its path
 *   relative to the project's root.
 * @returns {string} The project's root folder.
 */
function sampleProject(files) {
  const root = makeTestTempFolder("unused-src-modules");
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const json = (value) => JSON.stringify(value);

describe("nodeTargets", () => {
  it("names the file each node command of an npm script runs", () => {
    assert.deepStrictEqual(nodeTargets("node src/bot.js"), ["src/bot.js"]);
    assert.deepStrictEqual(
      nodeTargets("npm run build && node --watch src/server.js"),
      ["src/server.js"],
    );
    assert.deepStrictEqual(
      nodeTargets(
        "eslint src/ && node scripts/a.js --json && node scripts/b.js",
      ),
      ["scripts/a.js", "scripts/b.js"],
    );
  });

  it("leaves out a glob, which names no one file", () => {
    assert.deepStrictEqual(
      nodeTargets("node --test --test-concurrency=24 test/*.test.js"),
      [],
    );
  });
});

describe("appEntryFiles", () => {
  it("takes knip.json's entries, package.json's main and the npm scripts' files, tests left out", () => {
    const root = sampleProject({
      "knip.json": json({
        entry: [
          "src/telegram-send.js",
          "scripts/**/*.js",
          "util/**/*.js",
          "test/**/*.test.js",
        ],
      }),
      "package.json": json({
        main: "src/server.js",
        scripts: {
          bot: "node src/bot.js",
          dev: "npm run build && node --watch src/server.js",
          test: "node --test test/*.test.js util/test/*.test.js",
          "test:one": "node test/a.test.js",
        },
      }),
      "src/server.js": "",
      "src/bot.js": "",
      "src/telegram-send.js": "",
      "scripts/build.js": "",
      "util/tool/index.js": "",
      "util/test/tool.test.js": "",
      "test/a.test.js": "",
    });
    assert.deepStrictEqual(appEntryFiles(root), [
      "scripts/build.js",
      "src/bot.js",
      "src/server.js",
      "src/telegram-send.js",
      "util/tool/index.js",
    ]);
  });
});

describe("checkUnusedSrcModules", () => {
  it("reports a module only its own test loads, which knip counts as used", async () => {
    const root = sampleProject({
      "knip.json": json({ entry: ["test/**/*.test.js"] }),
      "package.json": json({ main: "src/server.js" }),
      "src/server.js": 'require("./lib/used");\n',
      "src/lib/used.js": "module.exports = {};\n",
      "src/lib/only-tested.js": "module.exports = {};\n",
      "test/only-tested.test.js": 'require("../src/lib/only-tested");\n',
    });
    const result = await checkUnusedSrcModules(root, {
      srcFiles: ["src/lib/only-tested.js", "src/lib/used.js", "src/server.js"],
    });
    assert.deepStrictEqual(result, {
      ok: false,
      entryPoints: 1,
      modules: 3,
      unused: ["src/lib/only-tested.js"],
    });
  });

  it("follows the dashboard's imports, into a CommonJS module they share", async () => {
    const root = sampleProject({
      "knip.json": json({ entry: ["src/client/web/dashboard-init.js"] }),
      "package.json": json({}),
      "src/client/web/dashboard-init.js":
        'import { a } from "./dashboard-a.js";\nconsole.log(a);\n',
      "src/client/web/dashboard-a.js":
        'import { rule } from "../../lib/rule.js";\nexport const a = rule;\n',
      "src/lib/rule.js": '"use strict";\nmodule.exports = { rule: 1 };\n',
      "src/client/web/dashboard-orphan.js": "export const x = 1;\n",
    });
    const result = await checkUnusedSrcModules(root, {
      srcFiles: [
        "src/client/web/dashboard-a.js",
        "src/client/web/dashboard-init.js",
        "src/client/web/dashboard-orphan.js",
        "src/lib/rule.js",
      ],
    });
    assert.deepStrictEqual(result.unused, [
      "src/client/web/dashboard-orphan.js",
    ]);
  });

  it("follows a require in a file that also imports", async () => {
    const root = sampleProject({
      "knip.json": json({ entry: [] }),
      "package.json": json({ main: "src/server.js" }),
      "src/server.js":
        'import x from "./lib/x.js";\nconst y = require("./lib/y");\nconsole.log(x, y);\n',
      "src/lib/x.js": "export default 1;\n",
      "src/lib/y.js": "module.exports = 2;\n",
    });
    const result = await checkUnusedSrcModules(root, {
      srcFiles: ["src/lib/x.js", "src/lib/y.js", "src/server.js"],
    });
    assert.deepStrictEqual(result.unused, []);
    assert.strictEqual(result.ok, true);
  });
});

describe("srcModuleFiles", () => {
  it("lists the .js files under src/ that git tracks, never the build's output", () => {
    const files = srcModuleFiles(path.join(__dirname, ".."));
    assert.ok(files.includes("src/server.js"));
    assert.ok(files.every((file) => file.endsWith(".js")));
    assert.ok(!files.some((file) => file.startsWith("src/client/web/dist/")));
  });
});
