"use strict";

/**
 * @file util/migration/update-099-env.js
 * @description
 * A migration step: bring `.env`, as release 0.9.9 read it, up to how
 * this release reads it.
 *
 * This release checks `.env` at startup against the list of variables
 * it reads, and reads each one by a strict rule, so two kinds of line
 * 0.9.9 took would stop the server:
 *
 *   - a variable this release no longer reads: `SLIPPAGE_PCT`, since
 *     slippage is two settings of each position now, and
 *     `AGGREGATOR_API_KEY`, since no aggregator takes a key. The line
 *     becomes a comment, so its value stays in the file to be seen;
 *   - `DRY_RUN` or `VERBOSE` written other than `true` or `false`. Each
 *     is written as 0.9.9 read it: 0.9.9 ran dry for 1, true or yes, in
 *     any letter case, and logged verbosely only for 1. So an install
 *     that ran dry still runs dry, and one that sent transactions still
 *     sends them.
 *
 * Each changed line is kept as a comment above what replaces it, so the
 * change can be undone by hand. No copy of the file is made: `.env`
 * holds the private key, and a copy would be a second place that key
 * lies in the clear. For the same reason the report names variables and
 * never quotes a value. The file is rewritten atomically, with its
 * permissions kept. Runs on Node built-ins only, like the rest of the
 * migration.
 */

const fs = require("fs");
const path = require("path");

/** The variables 0.9.9 read and this release does not, and why. */
const _RETIRED = Object.freeze({
  SLIPPAGE_PCT: "slippage is two settings of each position now",
  AGGREGATOR_API_KEY: "no aggregator takes a key now",
});

/** How 0.9.9 read each on/off variable: on for these, off otherwise. */
const _ON_IN_099 = Object.freeze({
  DRY_RUN: (t) => ["1", "true", "yes"].includes(t.toLowerCase()),
  VERBOSE: (t) => t === "1",
});

/*-
 *  A value as dotenv reads it: inside its quotes when quoted, otherwise
 *  up to a comment, trimmed.
 */
function _valueOf(rest) {
  const t = rest.trim();
  const q = t[0];
  if (q === '"' || q === "'" || q === "`") {
    const end = t.indexOf(q, 1);
    return end === -1 ? t.slice(1) : t.slice(1, end);
  }
  return t.replace(/\s+#.*$/, "").trim();
}

/** The quote a value opens and does not close on its line, or null. */
function _openQuote(rest) {
  const q = rest.trim()[0];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  return rest.trim().indexOf(q, 1) === -1 ? q : null;
}

/**
 * What a line sets: its `export ` prefix, if any, the name, and the rest
 * after the `=`; or null for a line that sets nothing, as dotenv reads it.
 */
function _setting(line) {
  const t = line.trim();
  const exported = /^export\s/.test(t);
  const bare = exported ? t.slice("export".length).trimStart() : t;
  const m = /^([\w.-]+)\s*=(.*)$/.exec(bare);
  if (m === null) return null;
  return { prefix: exported ? "export " : "", name: m[1], rest: m[2] };
}

/**
 * One line's replacement, and the report's line for it, or null when the
 * line stands. `s` is what the line sets.
 */
function _change(line, s, v) {
  const { prefix, name, rest } = s;
  if (Object.hasOwn(_RETIRED, name))
    return {
      lines: [
        `# LP Ranger reads ${name} no more; util/migration made it a comment:`,
        `# ${line}`,
      ],
      // A value running over further lines becomes a comment with it.
      commentsValue: true,
      said: `${v("made", "would make")} ${name} a comment: ${_RETIRED[name]}`,
    };
  const readAs = _ON_IN_099[name];
  const value = _valueOf(rest);
  if (readAs === undefined || value === "") return null;
  if (value === "true" || value === "false") return null;
  const now = readAs(value) ? "true" : "false";
  return {
    lines: [
      `# util/migration wrote this as 0.9.9 read it; it was: ${line}`,
      `${prefix}${name}=${now}`,
    ],
    said: `${v("wrote", "would write")} ${name} as ${now}, as 0.9.9 read it`,
  };
}

/** Every line of `text`, with the changes it needs. */
function _update(text, v) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out = [];
  const said = [];
  let open = null; // the quote a value running over lines opened with
  let commented = false; // whether that value's line became a comment
  for (const line of text.split(/\r?\n/)) {
    if (open !== null) {
      if (line.includes(open)) open = null;
      out.push(commented ? `# ${line}` : line);
      continue;
    }
    const s = _setting(line);
    const c = s === null ? null : _change(line, s, v);
    if (s !== null) open = _openQuote(s.rest);
    commented = c?.commentsValue === true;
    if (c === null) {
      out.push(line);
      continue;
    }
    out.push(...c.lines);
    said.push(`.env: ${c.said}`);
  }
  return { text: out.join(eol), said };
}

/**
 * Bring the install's `.env` up to how this release reads it.
 * @param {object} o
 * @param {string} o.root     The install's folder.
 * @param {boolean} o.dryRun  Report what would change, and change nothing.
 * @returns {string[]}  One line for each change, or none.
 */
function update099Env({ root, dryRun }) {
  const file = path.join(root, ".env");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const v = (done, would) => (dryRun ? would : done);
  const updated = _update(text, v);
  if (updated.said.length === 0 || dryRun) return updated.said;
  const mode = fs.statSync(file).mode & 0o777;
  fs.writeFileSync(`${file}.tmp`, updated.text, { mode });
  fs.chmodSync(`${file}.tmp`, mode);
  fs.renameSync(`${file}.tmp`, file);
  return updated.said;
}

module.exports = { update099Env };
