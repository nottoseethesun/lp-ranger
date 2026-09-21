---
name: bounds-and-bad-value-checks-belong-in-the-core-never-the-ui
description: "Validate every value on the server/core, because one core serves many frontends and a bad value must be stopped before it is used"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-09-21T04:39:46.009Z
---

Bounds checking and bad-value rejection are **always** done on the server, or in the app's core — never in the user interface.

**Why:** the core may have many frontends — a web dashboard today, an API client, a CLI, a second UI tomorrow. A check that lives in one frontend binds only the requests that come through it, so every other caller reaches the core unchecked. All bad values must be stopped before anything uses them, and the only place that can hold for every caller is the core itself. A rule copied into a frontend is also a rule that drifts: it silently becomes a second, different answer to the same question.

**How to apply:** put the rule in one core module, have every road into the value ask that module, and let the frontend simply send what the user typed. The frontend's job is to report the refusal — show the reason, restore the last accepted value, let the user edit and try again — not to pre-judge the value. Refuse rather than correct: a value quietly clamped to the nearest allowed figure leaves the app running on a setting nobody chose, and the setting is then the last thing anyone thinks to check.

Not covered by this rule: a confirmation prompt for a value that IS accepted and merely risky or expensive (the slippage confirmations above 5% and 10%). That is asking the user to mean it, not deciding whether the value is legal, and it belongs in the UI.

In LP Ranger the core module is `src/config-bounds.js`, with `src/timer-bounds.js` for anything that becomes a `setTimeout` delay. Related: [[feedback_no_duplication]], [[feedback_engineering_invariants]].
