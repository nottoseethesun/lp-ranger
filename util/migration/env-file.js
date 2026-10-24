"use strict";

/**
 * @file util/migration/env-file.js
 * @description
 * What the migration's steps share for an install's `.env`: reading each
 * line as dotenv reads it, changing the lines a step names, and writing
 * the file back.
 *
 * A step hands `rewriteEnv` a change for one line, which answers the
 * line's replacement or leaves it standing. Each changed line is kept as
 * a comment above what replaces it, so the change can be undone by hand;
 * a variable LP Ranger reads no more becomes a comment itself
 * (`retiredVariable`). No copy of the file is made: `.env` holds the
 * private key, and a copy would be a second place that key lies in the
 * clear. For the same reason a step's report names variables and never
 * quotes a value. The file is rewritten atomically, with its permissions
 * kept. Runs on Node built-ins only, like the rest of the migration.
 */

const fs = require("fs");
const path = require("path");

/*-
 *  A value as dotenv reads it: inside its quotes when quoted, otherwise
 *  up to a comment, trimmed.
 */
function valueOf(rest) {
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
 * A variable LP Ranger reads no more, made a comment: the change for its
 * line, as `rewriteEnv` takes one, with `why` for the report.
 * @param {string} line  The line setting it.
 * @param {string} name  The variable.
 * @param {string} why   Why LP Ranger reads it no more.
 * @param {Function} v   The verb: done, or would be done.
 * @returns {{lines: string[], commentsValue: boolean, said: string}}
 */
function retiredVariable(line, name, why, v) {
  return {
    lines: [
      `# LP Ranger reads ${name} no more; util/migration made it a comment:`,
      `# ${line}`,
    ],
    // A value running over further lines becomes a comment with it.
    commentsValue: true,
    said: `${v("made", "would make")} ${name} a comment: ${why}`,
  };
}

/** Every line of `text`, with the changes `change` gives. */
function _update(text, change, v) {
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
    const c = s === null ? null : change(line, s, v);
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
 * Change the install's `.env` line by line, unless this is a dry run.
 * @param {object} o
 * @param {string} o.root     The install's folder.
 * @param {boolean} o.dryRun  Report what would change, and change nothing.
 * @param {Function} change  `(line, setting, verb)`: the line's
 *   replacement, `{lines, commentsValue?, said}`, or null when it stands.
 *   `setting` is what the line sets: `{prefix, name, rest}`.
 * @returns {string[]}  One line for each change, or none.
 */
function rewriteEnv({ root, dryRun }, change) {
  const file = path.join(root, ".env");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const v = (done, would) => (dryRun ? would : done);
  const updated = _update(text, change, v);
  if (updated.said.length === 0 || dryRun) return updated.said;
  const mode = fs.statSync(file).mode & 0o777;
  fs.writeFileSync(`${file}.tmp`, updated.text, { mode });
  fs.chmodSync(`${file}.tmp`, mode);
  fs.renameSync(`${file}.tmp`, file);
  return updated.said;
}

module.exports = { valueOf, retiredVariable, rewriteEnv };
