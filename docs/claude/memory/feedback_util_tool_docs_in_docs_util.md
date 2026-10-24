---
name: util-tool-docs-in-docs-util
description: "A util/ tool's own documentation lives in a folder under docs/util/: user-manual.md, commands.md and engineering.md, loosely patterned on LP Ranger's own"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f8b08a58-72ba-4f26-a891-71b9e99630e4
  modified: 2026-10-22T01:23:59.274Z
---

A tool under `util/` with documentation of its own keeps it in a folder
under `docs/util/`, as the bookkeeping tools do in
`docs/util/bookkeeping-for-coins-in-transactions/`:

- `user-manual.md`, patterned on LP Ranger's User Manual
  (`public/help-and-user-manual.html`), leaving out what does not apply,
  such as Checking for Updates;
- `commands.md`, patterned on `docs/npm-project-commands.md`;
- `engineering.md`, patterned on `docs/engineering.md`.

`docs/engineering.md`'s entry for the tool only points to the folder,
and LP Ranger's User Manual names the tool's user manual by its path.

**Why:** the user, 2026-10-21, asked for the folder and its three
documents ("Do not rigidly follow the examples: Merely use them as
guidelines and suggestions"), then: "`docs/bookkeeping-for-coins-in-transactions/`
needs to be moved to, `docs/util/bookkeeping-for-coins-in-transactions/`".

**How to apply:** give each fact one of the three
([[doc-set-one-home-per-fact]]). Add the folder to `MARKDOWN_TARGETS`
in `scripts/lint-targets.js`, and check every cross-file link and anchor,
which markdownlint does not. A doc both moved and rewritten is committed
in two steps, the move alone first, so `git log --follow` keeps its
history: a rewrite under 50% alike is not seen as a rename.
