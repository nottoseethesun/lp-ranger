/**
 * @file scripts/build-bundles.js
 * @description Builds the browser's scripts with esbuild, one file per
 *   page: the dashboard's (`public/dashboard-init.js` →
 *   `public/dist/bundle.js`) and the User Manual's
 *   (`public/dashboard-manual-figures.js` →
 *   `public/dist/manual-figures.js`). The server lets a browser keep any
 *   script for a year, so each page's script must carry the build's
 *   cache-bust stamp (`scripts/cache-bust.js`). A page loading a module on
 *   its own would also load that module's imports, which no stamp in the
 *   page can reach; one bundle per page puts every module behind the one
 *   stamped tag.
 *
 *   `--watch` rebuilds both on every change, for `npm run build:watch`.
 */

"use strict";

const esbuild = require("esbuild");
const { log } = require("../src/log");

const BUNDLES = [
  {
    entryPoints: ["public/dashboard-init.js"],
    outfile: "public/dist/bundle.js",
  },
  {
    entryPoints: ["public/dashboard-manual-figures.js"],
    outfile: "public/dist/manual-figures.js",
  },
];

const OPTIONS = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  logLevel: "info",
};

/**
 * Build every bundle once, or keep rebuilding each on change.
 * @param {boolean} watch  Whether to watch instead of building once.
 * @returns {Promise<void>}
 */
async function buildBundles(watch) {
  for (const bundle of BUNDLES) {
    const options = { ...OPTIONS, ...bundle };
    if (watch) await (await esbuild.context(options)).watch();
    else await esbuild.build(options);
  }
}

buildBundles(process.argv.includes("--watch")).catch((err) => {
  log.error("[build-bundles] %s", err.message);
  process.exit(1);
});
