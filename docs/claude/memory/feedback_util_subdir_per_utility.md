---
name: feedback_util_subdir_per_utility
description: "A util/ tool needing more than one file gets its own subdirectory named for the utility, entry index.js — never sibling files sharing a name prefix"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8264efa3-921c-4733-b040-c9845e2b3a5e
  modified: 2026-09-28T21:59:38.807Z
---

In `util/`, one file per utility OR one directory per utility. The moment a
tool needs a second file (500-line cap, or isolating pure logic for tests), it
moves into its own subdirectory named for the utility, with `index.js` as the
entry point so it still runs as `node util/<category>/<utility>`. Never scatter
a tool's parts as sibling files sharing a name prefix
(`verify-compound-usd.js` + `verify-compound-usd-analysis.js` was rejected).

**Why:** Stated by the user 2026-08-04. Keeps each category directory a list of
tools rather than a list of fragments.

**How to apply:** Reference example is `util/diagnostic/verify-compound-usd/`:
`index.js` (CLI, chain I/O, rendering) + `analysis.js` (pure math and
formatting, no I/O). Tests do NOT move with the tool: every `util/` test
lives in `util/test/`, one directory for the whole tree, and
`npm run test:util` globs `util/test/*.test.js`. Watch the relative
require depth when moving files in: `../../src/x` becomes `../../../src/x`, and
`n/no-missing-require` catches it (see [[feedback_use_linter_to_locate_issues]]).
Per [[feedback_no_reexports]], the entry must not re-export the sibling
module's helpers — tests import each from its owner. Convention is documented
in `docs/engineering.md` § Utilities.
