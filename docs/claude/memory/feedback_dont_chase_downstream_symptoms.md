---
name: feedback-dont-chase-downstream-symptoms
description: "A symptom mentioned mid-fix is information, not a work order — and if it is downstream, drop it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-19T02:32:03.370Z
---

Two rules, and the first one comes first.

**A symptom described while a fix is in flight is information, not a
work order.** The user is telling you what they are seeing so you have
it. Acknowledge it; do not open an investigation, spawn a trace, or
start a fix unless they ask.

**If it is downstream of the fix in flight, drop it.** Ask "does this
need the upstream defect to be present?" Yes → say so in one line and
move on. No → it is independent, handle it normally. When restating
findings, leave downstream material out entirely rather than qualifying
it.

**Why:** the downstream symptom is usually the upstream bug wearing a
different face. Chasing it splits the work in two, doubles the report the
user has to read, and can end in a fix for a state the app will never
reach again. The user's words: "I had mentioned that other problem to you
just as extra information, not asking you to fix it — it's obviously very
downstream!"

Related: [[feedback-fix-only-what-was-asked]],
[[feedback-no-finding-without-a-failure]], [[feedback-basic-fix-first]],
[[feedback-one-thing-at-a-time]].
