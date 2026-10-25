/**
 * @file scripts/build-bundles.js
 * @description Builds the browser's scripts with esbuild, one bundle per
 *   page, then stamps every page and composes the dashboard's: the last
 *   steps of `npm run build`.
 *
 *   The two bundles are the dashboard's (`src/client/web/dashboard-init.js` →
 *   `src/client/web/dist/bundle.js`) and the User Manual's
 *   (`src/client/web/dashboard-manual-figures.js` →
 *   `src/client/web/dist/manual-figures.js`). The server lets a browser keep any
 *   script for a year, so a page must load each of its scripts under the
 *   build's fresh stamp (`scripts/cache-bust.js`). A module a page loaded
 *   on its own would bring imports no stamp in the page can reach; one
 *   bundle per page puts every module behind one stamped tag. The server
 *   shows the dashboard from `src/client/web/dist/index.html`, which
 *   `scripts/inline-svgs.js` composes from the stamped
 *   `src/client/web/index.html`, so it runs after the stamp.
 *
 *   `--watch`, for `npm run build:watch`, keeps rebuilding both bundles as
 *   their sources change, and ends each rebuild the same way, so a
 *   reloaded page loads the new bundle rather than the one it holds.
 */

"use strict";

const { spawnSync } = require("child_process");
const esbuild = require("esbuild");
const { log } = require("../src/lib/log");

const BUNDLES = [
  {
    entryPoints: ["src/client/web/dashboard-init.js"],
    outfile: "src/client/web/dist/bundle.js",
  },
  {
    entryPoints: ["src/client/web/dashboard-manual-figures.js"],
    outfile: "src/client/web/dist/manual-figures.js",
  },
];

const OPTIONS = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  logLevel: "info",
};

/** What follows a build of the bundles, in order. */
const STEPS_AFTER_BUNDLING = [
  "scripts/cache-bust.js",
  "scripts/inline-svgs.js",
];

/**
 * Run one of the steps that follow bundling, as its own node process.
 * @param {string} script  The step's script.
 * @throws {Error} When the step fails.
 */
function _runStep(script) {
  const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${script} failed`);
}

/**
 * Run every step that follows bundling, in order.
 * @param {Function} run  Runs one step.
 */
function _runStepsAfterBundling(run) {
  for (const script of STEPS_AFTER_BUNDLING) run(script);
}

/**
 * The esbuild plugin each `--watch` rebuild runs through: a rebuild that
 * succeeds ends with the steps that follow bundling. esbuild reports a
 * step that throws as the rebuild's error, and goes on watching.
 * @param {Function} run  Runs one step.
 * @returns {object}
 */
function _restampAfterRebuild(run) {
  return {
    name: "restamp-after-rebuild",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) _runStepsAfterBundling(run);
      });
    },
  };
}

/**
 * Build every bundle once and run the steps that follow, or keep
 * rebuilding each bundle as its sources change.
 * @param {boolean} watch  Whether to watch instead of building once.
 * @param {object} [bundler]  esbuild, unless a test passes its own.
 * @param {Function} [run]  Runs one step; `_runStep` unless a test passes
 *   its own.
 * @returns {Promise<void>}
 */
async function buildBundles(watch, bundler = esbuild, run = _runStep) {
  if (watch) {
    for (const bundle of BUNDLES) {
      const plugins = [_restampAfterRebuild(run)];
      const context = await bundler.context({ ...OPTIONS, ...bundle, plugins });
      await context.watch();
    }
    return;
  }
  for (const bundle of BUNDLES) await bundler.build({ ...OPTIONS, ...bundle });
  _runStepsAfterBundling(run);
}

if (require.main === module)
  buildBundles(process.argv.includes("--watch")).catch((err) => {
    log.error("[build-bundles] %s", err.message);
    process.exit(1);
  });

module.exports = { buildBundles };
