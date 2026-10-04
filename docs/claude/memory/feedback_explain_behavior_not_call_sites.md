---
name: feedback_explain_behavior_not_call_sites
description: "Explain a change by what happens and what someone would observe, in order, before naming any function. A paragraph built from private identifiers and control flow explains nothing, however accurate it is."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-02T20:50:18.553Z
---

When reporting what was changed and why, lead with **what happens** —
the feature, what went wrong, what a reader or operator would see. A
function name is a pointer for someone who has understood the point and
now wants to read the code. It is never the explanation.

**Why.** Twice on 2026-10-02. First: *"You've spewed out a lot of vague
material."* Then, quoting a paragraph of mine back verbatim: *"What the
fuck does this mean? … Do you have any idea how a reader has no idea what
you mean there?"*

The paragraph was accurate and useless:

> I first put the hold's announcement in `_drain` — but `acquire()` has
> two fast paths that return without ever draining once the halt is
> clear. On the common path the line would never have fired, and the
> deadline would have stayed set until some later moment when a queue
> happened to form, announcing itself then. It now sits in
> `_haltRemainingMs`, the one function every path asks.

Four private identifiers, no statement of what anybody would observe.
The same content, as it should have been written:

> When every rpc endpoint stops answering, the app stops sending
> requests for an hour. It announced the start of that hour and not the
> end. I added a line for the end — and put it somewhere the code only
> reaches when requests are queued up, which they usually are not by the
> time the hour runs out. So it would not have printed at all, and the
> app would still have believed it was paused: hours later, the first
> time requests did pile up, it would have announced a wait that had
> ended long before. It now sits on the check every request makes, so
> whichever asks first notices and says so, once.

**How to apply.**

- Order: the feature, then the behaviour that was wrong, then what a
  reader would see, then the fix. File and function names come after
  that, if at all.
- A sentence carrying two private identifiers and no observable
  consequence is a sentence to rewrite, not to footnote.
- This applies to chat, commit messages and release notes alike. The
  commit may then name the call site, because whoever reads a commit is
  about to read the diff — but even there the first paragraph says what
  happens.
- The test: could someone who has never opened the file follow it? If
  not, it is not an explanation yet.

Related: [[feedback_no_internal_constants_in_design_talk]] (same
instinct, about constants), [[feedback_operator_sees_ui_not_logs]] (same
instinct, about app state), [[feedback_general_to_specific]],
[[feedback_prose_style]].
