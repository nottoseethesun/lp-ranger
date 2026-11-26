---
name: audit-english-by-the-handoff
description: "Audits of the English in docs, help, JSDoc, comments and test titles follow docs/claude/CLAUDE-ENGLISH-AUDIT.md"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 54faebf5-9812-48c8-8743-e2dde6ca5007
  modified: 2026-11-25T19:15:21.548Z
---

An audit of the English in the docs, the command-line help, the JSDoc,
the comments and the test titles follows the user's hand-off,
docs/claude/CLAUDE-ENGLISH-AUDIT.md: its standard for every text, every
claim checked against the code, significant findings only, fixes that
quote the whole text they replace, and the fresh-reader loop that checks
a report of doc fixes before they are made.

**Why:** the user recorded it, 2026-11-25, "because it details how to
properly audit English writing for computer projects".

**How to apply:** brief each audit round's docs-and-comments auditor
with it, and hold my own pass one to it. See [[feedback_prose_style]]
and [[docs-always-updated]].

**At scale, say what the loop costs first (2026-11-25).** The first wave
(13 reviewers, about 650 findings) would have needed about as many fresh
readers again for the loop's first pass alone. Told that, the user
scoped it: "only fix incorrect facts in the doc (including functionality
that is no longer there) - that should be pretty quick and a fairly
small cost in Claude tokens." So the fixes were wrong facts only, applied
by fixers that each owned separate files and confirmed every claim
against the code first, with no fresh-reader loop; missing detail, rule
findings and wording were skipped. Then "Don't do any more audits
actually" ended the waves. See [[feedback_token_cost_first]].
