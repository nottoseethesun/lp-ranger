---
name: feedback_docs_dont_restate_checks
description: "Docs state a setting's meaning and range once; they do not list the values the checks refuse or repeat that a bad value stops startup"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-19T18:50:04.056Z
---

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
