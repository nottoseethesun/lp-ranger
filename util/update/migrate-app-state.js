#!/usr/bin/env node
/**
 * @file util/update/migrate-app-state.js
 * @description
 * Carry an existing install's operator state into a freshly extracted
 * release, without touching anything the release ships.
 *
 * This is Step Six of the Update section in README.md.  It replaces a
 * hand-typed `cp -rn`, which had two problems: it is a Unix command, so
 * Windows operators had to be sent to Git Bash for one line of an
 * otherwise cross-platform procedure; and excluding `node_modules` from
 * it needed shell options (`shopt -s extglob`) that do not exist in
 * zsh, the default shell on macOS.
 *
 * Copies are strictly **no-clobber**: anything already present in the
 * new install is left exactly as shipped, so a release can change a
 * default without an old file silently overwriting it.  Nothing in the
 * old install is modified or removed &mdash; it stays intact as a
 * rollback.
 *
 * Runs on Node built-ins only.  It executes BEFORE `npm ci` in the
 * update procedure, so `node_modules` may not exist yet and this file
 * must not require anything from it.
 *
 * The CLI is self-documenting &mdash; run with `--help` for the full
 * reference.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/**
 * The operator-state paths an update carries forward, and all of them.
 *
 * Kept in step with the "What Step Six carries forward" list in
 * README.md.  `node_modules` is deliberately absent: it is large, and
 * the next step installs it from the new release's lockfile.  The scan
 * caches now live in `app-data/scan-cache/`; `tmp` stays on the list
 * because a release before that kept them in `tmp/`, and the migration
 * step after this one (util/migration/) moves them across.
 */
const MIGRATED_ITEMS = [".env", "app-config", "app-data", "tmp"];

const HELP_TEXT = `
migrate-app-state — carry operator state into a freshly extracted release

USAGE
  cd lp-ranger-<new-version>
  node ./util/update/migrate-app-state.js [options]

WHAT IT COPIES
  ${MIGRATED_ITEMS.join(", ")}

  Copies never overwrite: anything already present in the new install is
  left as shipped. The old install is never modified.

OPTIONS
  --from <dir>   The old install to copy from. Omit it and the script
                 looks for a single sibling lp-ranger-* directory.
  --dry-run      Report what would be copied, write nothing.
  --help         Show this text.

EXAMPLES
  node ./util/update/migrate-app-state.js
  node ./util/update/migrate-app-state.js --from ../lp-ranger-0.9.1
  node ./util/update/migrate-app-state.js --dry-run
`.trim();

/**
 * Parse argv.
 * @param {string[]} argv  Arguments after the script name.
 * @returns {{from: string, dryRun: boolean, help: boolean, bad: string}}
 */
function parseArgs(argv) {
  const out = { from: "", dryRun: false, help: false, bad: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--from") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        out.bad = "--from needs a directory path";
      else {
        out.from = next;
        i++;
      }
    } else out.bad = "Unrecognized argument: " + a;
  }
  return out;
}

/**
 * Whether a directory is an LP Ranger install.
 * @param {string} dir
 * @returns {boolean}
 */
function isLpRangerInstall(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
    return JSON.parse(raw).name === "lp-ranger";
  } catch {
    return false;
  }
}

/**
 * Sibling directories that look like another LP Ranger install.
 * @param {string} cwd  The new install (absolute).
 * @returns {string[]}  Absolute paths, sorted.
 */
function findSourceCandidates(cwd) {
  const parent = path.dirname(cwd);
  const self = path.basename(cwd);
  let names;
  try {
    names = fs.readdirSync(parent);
  } catch {
    return [];
  }
  return names
    .filter((n) => n !== self && n.startsWith("lp-ranger-"))
    .map((n) => path.join(parent, n))
    .filter(isLpRangerInstall)
    .sort();
}

/**
 * Decide which install to copy from.
 *
 * Refuses to guess between several candidates rather than picking one:
 * copying the wrong install's wallet and bot config into a new release
 * is not something the operator would notice quickly.
 *
 * @param {object} opts
 * @param {string} opts.from        Explicit `--from`, or "".
 * @param {string[]} opts.candidates  Absolute paths of possible sources.
 * @returns {{dir: string}|{error: string}}
 */
function resolveSource({ from, candidates }) {
  if (from) return { dir: from };
  if (candidates.length === 0)
    return {
      error:
        "No other lp-ranger-* install found next to this one.\n" +
        "Pass the old install explicitly:  --from ../lp-ranger-<old-version>",
    };
  if (candidates.length > 1)
    return {
      error:
        "Found more than one possible source:\n" +
        candidates.map((c) => "  " + path.basename(c)).join("\n") +
        "\nPass the one you mean:  --from ../lp-ranger-<old-version>",
    };
  return { dir: candidates[0] };
}

/**
 * Record one file into an item's plan: copy it, or note it is already
 * present in the destination and must be left alone.
 */
function _planFile(rel, destRoot, entry) {
  if (fs.existsSync(path.join(destRoot, rel))) entry.skipped.push(rel);
  else entry.copy.push(rel);
}

/** Walk one path, recording every regular file beneath it. */
function _walk(srcRoot, destRoot, rel, entry) {
  const src = path.join(srcRoot, rel);
  let st;
  try {
    st = fs.lstatSync(src);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(src).sort())
      _walk(srcRoot, destRoot, path.join(rel, name), entry);
    return;
  }
  if (st.isFile()) _planFile(rel, destRoot, entry);
}

/**
 * Work out what would be copied, without writing anything.
 * @param {string} srcRoot   Old install (absolute).
 * @param {string} destRoot  New install (absolute).
 * @param {string[]} items   Top-level paths to carry across.
 * @returns {Array<{item: string, missing: boolean, copy: string[], skipped: string[]}>}
 */
function buildPlan(srcRoot, destRoot, items) {
  return items.map((item) => {
    const entry = { item, missing: false, copy: [], skipped: [] };
    if (!fs.existsSync(path.join(srcRoot, item))) {
      entry.missing = true;
      return entry;
    }
    _walk(srcRoot, destRoot, item, entry);
    return entry;
  });
}

/**
 * Execute a plan.  Only files in `copy` are written, so nothing already
 * in the new install is touched.
 * @param {string} srcRoot
 * @param {string} destRoot
 * @param {Array} plan  From `buildPlan`.
 * @returns {number}  Files written.
 */
function applyPlan(srcRoot, destRoot, plan) {
  let written = 0;
  for (const entry of plan) {
    for (const rel of entry.copy) {
      const dest = path.join(destRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(srcRoot, rel), dest);
      written++;
    }
  }
  return written;
}

/**
 * Human-readable lines describing a plan.
 * @param {Array} plan  From `buildPlan`.
 * @returns {string[]}
 */
function formatPlan(plan) {
  const lines = [];
  for (const e of plan) {
    if (e.missing) {
      lines.push("  " + e.item.padEnd(12) + "not in the old install");
      continue;
    }
    const parts = [e.copy.length + " to copy"];
    if (e.skipped.length)
      parts.push(e.skipped.length + " already present (kept as shipped)");
    lines.push("  " + e.item.padEnd(12) + parts.join(", "));
  }
  return lines;
}

/** Total files a plan would write. */
function planTotal(plan) {
  return plan.reduce((n, e) => n + e.copy.length, 0);
}

/**
 * Validate the two directories, returning an error string or "".
 * @param {string} cwd
 * @param {string} src
 * @returns {string}
 */
function validateDirs(cwd, src) {
  if (!isLpRangerInstall(cwd))
    return (
      "This does not look like an LP Ranger install:\n  " +
      cwd +
      "\nRun the script from inside the newly extracted release directory."
    );
  if (src === cwd) return "Source and destination are the same directory.";
  if (!isLpRangerInstall(src)) return "Not an LP Ranger install:\n  " + src;
  return "";
}

/**
 * CLI entry.
 * @param {string[]} argv  Arguments after the script name.
 * @returns {number}  Process exit code.
 */
function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP_TEXT);
    return 0;
  }
  if (args.bad) {
    console.error(args.bad + "\n\nRun with --help for usage.");
    return 1;
  }
  const cwd = process.cwd();
  const resolved = resolveSource({
    from: args.from,
    candidates: findSourceCandidates(cwd),
  });
  if (resolved.error) {
    console.error(resolved.error);
    return 1;
  }
  const src = path.resolve(resolved.dir);
  const problem = validateDirs(cwd, src);
  if (problem) {
    console.error(problem);
    return 1;
  }
  const plan = buildPlan(src, cwd, MIGRATED_ITEMS);
  console.log("Carrying operator state forward");
  console.log("  from: " + src);
  console.log("  into: " + cwd + "\n");
  for (const line of formatPlan(plan)) console.log(line);
  if (args.dryRun) {
    console.log("\nDry run — nothing written.");
    return 0;
  }
  const written = applyPlan(src, cwd, plan);
  console.log("\n" + written + " file(s) copied. Next step: npm ci");
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  MIGRATED_ITEMS,
  HELP_TEXT,
  parseArgs,
  isLpRangerInstall,
  findSourceCandidates,
  resolveSource,
  buildPlan,
  applyPlan,
  formatPlan,
  planTotal,
  validateDirs,
  main,
};
