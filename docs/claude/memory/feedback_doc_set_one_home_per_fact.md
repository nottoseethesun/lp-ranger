---
name: doc-set-one-home-per-fact
description: "In a set of docs for one tool (user manual, commands, engineering), each fact has one home and the others point to it: Quick Start in the user manual; an engineering doc's Commands section is only a pointer; user-facing rules such as time zones live in the user manual"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f8b08a58-72ba-4f26-a891-71b9e99630e4
  modified: 2026-10-22T01:18:35.427Z
---

When a tool gets a set of documents (a user manual, a commands
reference, an engineering reference), each fact lives in one of them,
and the others point to it rather than restate it:

- Quick Start belongs in the user manual, not the engineering reference.
- The engineering reference's Commands section only points to the
  commands document: no table, nothing more.
- What a user sees and does (time zones and the last whole day, prompts,
  messages, what to do when a run stops) lives in the user manual. The
  engineering reference keeps how each part works and refers to the
  manual's section; the commands document's notes refer to it too.

**Why:** the user, 2026-10-21, on the bookkeeping tools' docs: "You need
to look more at what you are doing: 'Quick Start' belongs in the
`user-manual.md`, not in the `engineering.md`! The commands section only
needs to point to the `commands.md`, nothing more. For time-zone info
such as 'The Last Whole Day', refer the reader to the appropriate
section in the user-manual." I had carried each example document's
sections into every new one, and stated the same facts in all three.

**How to apply:** before writing, give each topic one document by its
reader: a user's steps and answers to the manual, command syntax to the
commands reference, mechanism to the engineering reference. Elsewhere,
a one-line pointer to that section. After writing, read the documents
side by side for any fact said twice. Related:
[[docs-dont-restate-checks]], [[docs-always-updated]].
