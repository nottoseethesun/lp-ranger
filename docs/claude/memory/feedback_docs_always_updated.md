---
name: docs-always-updated
description: "Docs that describe a change are updated in the same change, without asking first"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f8b08a58-72ba-4f26-a891-71b9e99630e4
  modified: 2026-10-20T22:47:05.055Z
---

When a change makes a doc stale (the guide, `docs/engineering.md`, the
User Manual, a `--help` text, CLAUDE.md), update that doc in the same
change. Do not ask whether to.

**Why:** the user, 2026-10-20, asked whether the bookkeeping docs should be
updated along with a tool change: "Yes always."

**How to apply:** list the docs a change touches while planning it, and
treat their update as part of the work, like its tests. A scope limit the
user sets for code (such as "only util/bookkeeping") does not stop the
docs that describe that code. Related: [[feedback_verify_symbols_a_comment_names]],
[[feedback_audit_before_declaring_done]].
