---
name: docs-always-updated
description: "A doc a change makes stale is updated in the same change; a setting's meaning and range are stated once, with no lists of refused values; user-facing rules live in the manual and the other docs point there"
metadata:
  type: feedback
---

# Docs

Merged from: feedback_docs_dont_restate_checks, feedback_doc_set_one_home_per_fact — those slugs no longer exist
separately; search this one.

## docs always updated

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

## docs don't restate checks

Where the code checks a value's kind and range, the docs do not repeat
the check. A setting's entry says what it does and its range, once. The
one statement that a wrong value stops startup lives in "Checking the
Settings" (docs/configuration.md), and nowhere else.

**Why:** in the eleventh audit the docs listed `.env` variables that stop
startup, and repeated "stops startup" for files and values across
several pages. The user, 2026-10-19: "if the datatype and range-bounds
checking are correct, why are they even mentioned in the documentation?
Sounds like you have been spewing unnecessary bulk like that all over
the place; if you agree, please stop and fix what you did." Also: "the
doc must not contradict itself on anything". A repeated rule is a second
copy that drifts: the manual still said pacing 0 turns pacing off after
the range was raised to 5.

**How to apply:** before adding a sentence about what a value may be,
check whether a check enforces it; if so, give the range in the
setting's own entry and stop. When discussing a numeric setting, name it
and state its range, and check the range is sane for what the setting
does, not just derived from a generic multiple. Related:
[[feedback_prose_style]], [[feedback_one_literal_per_shipped_default]].

## one home per fact in a doc set

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
