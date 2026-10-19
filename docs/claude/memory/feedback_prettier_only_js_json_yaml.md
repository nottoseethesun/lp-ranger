---
name: feedback-prettier-only-js-json-yaml
description: "Prettier formats only JS, JSON and YAML here; never `prettier --write` a Markdown or HTML file — it rewrites the whole file"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-19T00:59:49.752Z
---

Run `prettier --write` only on `.js`, `.json` and `.yml`/`.yaml` files. The gate (`scripts/check.js`) checks Prettier on `JS_TARGETS`, `**/*.json` and `**/*.{yml,yaml}`, nothing else. Markdown is checked by markdownlint, and the User Manual's HTML by nothing that formats it, so neither is Prettier-clean.

**Why:** on 2026-10-18 I passed CLAUDE.md, docs/engineering.md, PROJECT-STATE.md and public/help-and-user-manual.html to `prettier --write` with the JS files I had changed. It realigned CLAUDE.md's tables, rewrapped docs/engineering.md, changed `*value*` to `_value_` in PROJECT-STATE, and rewrote 2,352 lines of the manual. The Markdown names in `scripts/lint-targets.js` misled me: that list is markdownlint's. I restored the four files from Claude Code's file history (`~/.claude/file-history/<session>/`, the snapshot taken at the turn's start) and made the turn's edits again with the Edit tool.

**How to apply:** list only JS, JSON and YAML files in a `prettier --write` call. If a Markdown or HTML file is reformatted by mistake, take its pre-turn snapshot from the file history (match it by content and timestamp, and diff it against `git show HEAD:<file>` to confirm it holds only the session's own changes), then re-apply the turn's edits. Never `git checkout` it, which loses the session's uncommitted changes ([[feedback_never_stash_to_compare]]).
