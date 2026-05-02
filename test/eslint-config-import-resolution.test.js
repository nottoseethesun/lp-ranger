/**
 * @file test/eslint-config-import-resolution.test.js
 * @description Integration test for the project's ESLint flat config:
 * verifies that `n/no-missing-import` is wired for dashboard ES modules
 * and `n/no-missing-require` is wired for Node CommonJS source files.
 *
 * Closes the PR #116 gap where a renamed dashboard module's stale
 * `import` passed lint + tests + CI green and only blew up at esbuild
 * time. A future config edit that disables either rule will fail this
 * test instead of slipping through.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ESLint } = require("eslint");

const PROJECT_ROOT = path.resolve(__dirname, "..");

describe("eslint-config import-resolution wiring", () => {
  it("flags a missing import in a dashboard ES module", async () => {
    const eslint = new ESLint({ cwd: PROJECT_ROOT });
    const results = await eslint.lintText(
      'import { foo } from "./dashboard-this-file-does-not-exist.js";\n' +
        "console.log(foo);\n",
      { filePath: path.join(PROJECT_ROOT, "public/dashboard-fake.js") },
    );
    const rules = results[0].messages.map((m) => m.ruleId);
    assert.ok(
      rules.includes("n/no-missing-import"),
      `expected n/no-missing-import to fire, got: ${rules.join(", ")}`,
    );
  });

  it("flags a missing require() in a src/ CommonJS file", async () => {
    const eslint = new ESLint({ cwd: PROJECT_ROOT });
    const results = await eslint.lintText(
      '"use strict";\n' +
        'const x = require("./this-module-does-not-exist");\n' +
        "module.exports = x;\n",
      { filePath: path.join(PROJECT_ROOT, "src/fake-module.js") },
    );
    const rules = results[0].messages.map((m) => m.ruleId);
    assert.ok(
      rules.includes("n/no-missing-require"),
      `expected n/no-missing-require to fire, got: ${rules.join(", ")}`,
    );
  });

  it("does NOT flag a valid relative import in a dashboard module", async () => {
    const eslint = new ESLint({ cwd: PROJECT_ROOT });
    const results = await eslint.lintText(
      'import { g } from "./dashboard-helpers.js";\n' + "console.log(g);\n",
      { filePath: path.join(PROJECT_ROOT, "public/dashboard-fake.js") },
    );
    const missing = results[0].messages.filter(
      (m) => m.ruleId === "n/no-missing-import",
    );
    assert.equal(
      missing.length,
      0,
      `unexpected n/no-missing-import errors: ${JSON.stringify(missing)}`,
    );
  });

  it("does NOT flag a bare-specifier import resolvable from node_modules", async () => {
    const eslint = new ESLint({ cwd: PROJECT_ROOT });
    const results = await eslint.lintText(
      'import { ethers } from "ethers";\n' + "console.log(ethers);\n",
      { filePath: path.join(PROJECT_ROOT, "public/dashboard-fake.js") },
    );
    const missing = results[0].messages.filter(
      (m) => m.ruleId === "n/no-missing-import",
    );
    assert.equal(
      missing.length,
      0,
      `unexpected n/no-missing-import errors: ${JSON.stringify(missing)}`,
    );
  });
});
