---
name: feedback_bad_operator_not_a_bug
description: "A finding that needs the operator to run LP Ranger wrongly (under a second OS account, with sudo) is a feature to cover a bad operator, not a bug; don't report it as one"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-28T06:12:34.677Z
---

A finding whose scenario needs the operator to run LP Ranger in a way
it is not meant to run, such as under a second account on the machine
or with `sudo`, is a feature to cover for a bad operator. It is not a
bug: don't report it as one, and don't propose a fix.

**Why:** the twenty-ninth audit reported [A29-7]:
`npm run build-and-start -- --delete-all-caches-and-logs` reads an LP
Ranger it may not signal (run under another account, as with
`sudo npm run bot`) as not running, and goes on to delete. The user,
2026-11-28: *"[A29-7] - Won't fix - this is a feature to cover for a bad
operator, so we won't do anything for it."*

**How to apply:** before reporting a finding, ask whether its scenario
needs the operator to run the install against its documented use. If
so, leave it out of the bugs. This is not about a failure the app meets
on its own (a full disk, a damaged file, an endpoint down), which the
app must handle. Related: [[feedback_operator_controls_the_wallet]],
[[feedback_bug_only_if_current_stack_breaks]],
[[feedback_no_finding_without_a_failure]].
