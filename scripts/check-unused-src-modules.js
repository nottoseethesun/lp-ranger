/**
 * @file scripts/check-unused-src-modules.js
 * @description The gate that fails when a module under `src/` is loaded
 * by no part of the app: run by `npm run lint` and `npm run check`, and
 * driven by `test/check-unused-src-modules.test.js`.
 *
 * knip's unused-files pass (`npm run knip:files`) counts every test as an
 * entry point, as it must, or it would call the test helpers, and the
 * packages only the tests use, unused. So a module that only its own
 * tests load passes it, though no part of the app can ever run it. This
 * check walks the dependencies (madge) from the app's entry points alone,
 * and reports each `.js` file under `src/` the walk does not reach.
 *
 * The entry points are the ones knip starts from, the tests left out:
 * the files knip.json's `entry` list names, package.json's `main`, and
 * each file an npm script runs with `node`. A test is any file under
 * `test/` or `util/test/`. The modules checked are the `.js` files under
 * `src/` that git tracks or would track, so the build's output
 * (`src/client/web/dist/`) and the files the build generates are left
 * out. A file the app starts by its path rather than loading it, as the
 * server starts `src/telegram-send.js`, belongs in knip.json's `entry`
 * list, where both checks find it.
 *
 * Exit status is 0 when the walk reaches every module, 1 otherwise.
 * `--json` prints the machine-readable result the check report reads.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const madge = require("madge");

const ROOT = path.join(__dirname, "..");

/** The folders the tests live in: no file in them is an entry point. */
const TEST_FOLDERS = ["test/", "util/test/"];

/**
 * A path relative to the project's root, with forward slashes, the form
 * git's file list and madge's graph both give.
 * @param {string} file
 * @returns {string}
 */
function _posix(file) {
  return file.split(path.sep).join("/");
}

/**
 * Whether a file is a test, or a helper only the tests load.
 * @param {string} file  Relative to the project's root.
 * @returns {boolean}
 */
function _isTest(file) {
  return TEST_FOLDERS.some((folder) => file.startsWith(folder));
}

/**
 * The files an npm script runs with `node`: in each command of the
 * script, the first argument after `node` and its flags, when it names a
 * `.js` file. A glob, such as the test runner's `test/*.test.js`, names
 * no one file and is left out.
 * @param {string} script  An npm script's command line.
 * @returns {string[]}
 */
function nodeTargets(script) {
  const targets = [];
  for (const command of script.split(/&&|\|\||;|\|/)) {
    const words = command.trim().split(/\s+/);
    if (words[0] !== "node") continue;
    const target = words.slice(1).find((word) => !word.startsWith("-"));
    if (target === undefined) continue;
    if (target.endsWith(".js") && !target.includes("*")) targets.push(target);
  }
  return targets;
}

/**
 * Read a JSON file of the project.
 * @param {string} root
 * @param {string} name  Its path, relative to the project's root.
 * @returns {object}
 */
function _readProjectJson(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
}

/**
 * The app's entry points, relative to the project's root and sorted: the
 * files knip.json's `entry` globs match, package.json's `main`, and the
 * files the npm scripts run with `node`, each test left out.
 * @param {string} root  The project's root folder.
 * @returns {string[]}
 */
function appEntryFiles(root) {
  const knip = _readProjectJson(root, "knip.json");
  const pkg = _readProjectJson(root, "package.json");
  const files = knip.entry.flatMap((glob) => fs.globSync(glob, { cwd: root }));
  if (pkg.scripts !== undefined)
    files.push(...Object.values(pkg.scripts).flatMap(nodeTargets));
  if (typeof pkg.main === "string") files.push(pkg.main);
  return [...new Set(files.map(_posix))]
    .filter((file) => !_isTest(file) && fs.existsSync(path.join(root, file)))
    .sort();
}

/**
 * The `.js` files under `src/` that git tracks or would track: those in
 * its index and those not yet added, less any it ignores. A file deleted
 * from the folder but still in the index is left out.
 * @param {string} root  The project's root folder, a git working tree.
 * @returns {string[]}
 */
function srcModuleFiles(root) {
  const git = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "src"],
    { cwd: root, encoding: "utf8" },
  );
  if (git.error !== undefined) throw git.error;
  if (git.status !== 0)
    throw new Error(`git ls-files failed: ${git.stderr.trim()}`);
  const files = git.stdout
    .split("\0")
    .filter((file) => file.endsWith(".js"))
    .filter((file) => fs.existsSync(path.join(root, file)));
  return [...new Set(files)].sort();
}

/**
 * Every file the walk reaches from the entry points, the entry points
 * included, relative to the project's root. madge follows `require` and
 * `import` alike, both in one file included, and leaves out packages.
 * @param {string} root
 * @param {string[]} entryFiles  Relative to the project's root.
 * @returns {Promise<Set<string>>}
 */
async function _reachedFiles(root, entryFiles) {
  const walk = await madge(
    entryFiles.map((file) => path.join(root, file)),
    {
      baseDir: root,
      fileExtensions: ["js"],
      detectiveOptions: { es6: { mixedImports: true } },
    },
  );
  const reached = new Set();
  for (const [file, dependencies] of Object.entries(walk.obj())) {
    reached.add(_posix(file));
    for (const dependency of dependencies) reached.add(_posix(dependency));
  }
  return reached;
}

/**
 * The check: each module under `src/` that the walk from the app's entry
 * points does not reach.
 * @param {string} root  The project's root folder.
 * @param {{entryFiles?: string[], srcFiles?: string[]}} [lists]  Either
 *   file list, when the caller has it, as a test's sample project, which
 *   is no git working tree, has its modules; each defaults to the
 *   project's own (`appEntryFiles`, `srcModuleFiles`).
 * @returns {Promise<{ok: boolean, entryPoints: number, modules: number,
 *   unused: string[]}>}
 */
async function checkUnusedSrcModules(root, lists = {}) {
  const entryFiles =
    lists.entryFiles === undefined ? appEntryFiles(root) : lists.entryFiles;
  const srcFiles =
    lists.srcFiles === undefined ? srcModuleFiles(root) : lists.srcFiles;
  const reached = await _reachedFiles(root, entryFiles);
  const unused = srcFiles.filter((file) => !reached.has(file));
  return {
    ok: unused.length === 0,
    entryPoints: entryFiles.length,
    modules: srcFiles.length,
    unused,
  };
}

/**
 * Print the result for a person, or as JSON with `--json`.
 * @param {{ok: boolean, entryPoints: number, modules: number,
 *   unused: string[], error?: string}} result
 */
function _print(result) {
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.error !== undefined) {
    console.error(
      `[unused-src-modules] the check did not run: ${result.error}`,
    );
  } else if (result.ok) {
    console.log(
      `[unused-src-modules] every module under src/ is used: ` +
        `${result.modules} modules, reached from ${result.entryPoints} entry points`,
    );
  } else {
    for (const file of result.unused)
      console.error(
        `[unused-src-modules] ${file}: no part of the app loads it`,
      );
    console.error(
      `[unused-src-modules] ${result.unused.length} of ${result.modules} ` +
        `modules under src/ are unused. Delete each one nothing needs; a file ` +
        `the app starts by its path goes in knip.json's entry list.`,
    );
  }
}

async function main() {
  let result;
  try {
    result = await checkUnusedSrcModules(ROOT);
  } catch (err) {
    result = {
      ok: false,
      entryPoints: 0,
      modules: 0,
      unused: [],
      error: err.message,
    };
  }
  _print(result);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  checkUnusedSrcModules,
  appEntryFiles,
  srcModuleFiles,
  nodeTargets,
};
