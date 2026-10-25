"use strict";

/**
 * @file test/build-bundles.test.js
 * @description Once the browser's bundles are built, every page is
 *   stamped (scripts/cache-bust.js) and then the dashboard's page is
 *   composed (scripts/inline-svgs.js), since the page the server shows
 *   must carry the stamp. `npm run build:watch` ends each rebuild the same
 *   way: without a fresh stamp, a reloaded page would keep the bundle it
 *   holds, which the server lets a browser keep for a year.
 *
 *   Drives `buildBundles` with a stand-in for esbuild and for running
 *   each step, so nothing is bundled and no page is written.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildBundles } = require("../scripts/build-bundles");

const DASHBOARD = "src/client/web/dist/bundle.js";
const MANUAL = "src/client/web/dist/manual-figures.js";
const STEPS = ["scripts/cache-bust.js", "scripts/inline-svgs.js"];

/**
 * A stand-in for esbuild that records what it is asked to do in `done`.
 * Watching a bundle ends one rebuild of it with `result`, as esbuild
 * does when a source changes.
 */
function fakeEsbuild(done, result) {
  return {
    build: async (options) => {
      done.push(`build ${options.outfile}`);
    },
    context: async (options) => {
      const ends = [];
      for (const plugin of options.plugins)
        plugin.setup({ onEnd: (end) => ends.push(end) });
      return {
        watch: async () => {
          done.push(`watch ${options.outfile}`);
          for (const end of ends) end(result);
        },
      };
    },
  };
}

/** Build as `npm run build` or `npm run build:watch` does; what was done. */
async function build(watch, result) {
  const done = [];
  await buildBundles(watch, fakeEsbuild(done, result), (step) =>
    done.push(step),
  );
  return done;
}

describe("building the bundles", () => {
  it("stamps every page, then composes the dashboard's, once both are built", async () => {
    assert.deepEqual(await build(false), [
      `build ${DASHBOARD}`,
      `build ${MANUAL}`,
      ...STEPS,
    ]);
  });

  it("under --watch, ends each rebuild the same way", async () => {
    assert.deepEqual(await build(true, { errors: [] }), [
      `watch ${DASHBOARD}`,
      ...STEPS,
      `watch ${MANUAL}`,
      ...STEPS,
    ]);
  });

  it("under --watch, leaves the pages alone after a rebuild that fails", async () => {
    assert.deepEqual(await build(true, { errors: [{ text: "broken" }] }), [
      `watch ${DASHBOARD}`,
      `watch ${MANUAL}`,
    ]);
  });
});
