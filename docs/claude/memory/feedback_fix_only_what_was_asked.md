---
name: fix-only-what-was-asked
description: "When user says \"fix X\" or \"stop doing Y\", change only X (or only Y). Do not sweep adjacent things that \"look similar\" and might have the same class of problem."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d932d59e-01b4-45db-82b1-6d987abcda8f
  modified: 2026-10-18T02:51:40.783Z
---

When the user calls out a specific problem ("just use regular quotes", "stop it with the fancy character-entities"), change ONLY that thing. Do NOT expand the fix to adjacent things you assume are the same class of problem.

**Why:** Session 2026-07-18, param-help-content.js. User pointed at `&ldquo;`/`&rdquo;` rendering as literal text in a popover heading and said "just use regular quotes; stop it with the fancy character-entities that you keep screwing up". I read that as license to sweep every character entity out of the sections I wrote — `&mdash;` → `--`, `&ndash;` → `-`, `&plusmn;` → `+/-`, `&times;` → `x`, `&minus;` → `-`, `&rsquo;` → `'`, `&gt;` → `>`. The user's response: "The quote marks were the only thing you kept screwing up, but you went and did more. It doesn't matter - just leave it. I meant for you to only just use regular quote marks."

The em-dashes and other entities were fine in body copy (rendered via innerHTML). Only the *quotes in the heading* were broken (rendered via textContent). By sweeping, I traded a proper typographic body for uglier ASCII with no corresponding gain.

**How to apply:**
- Read the user's callout literally. "Regular quotes" = quotes. Not dashes, not pluses, not greater-thans.
- If I'm tempted to expand ("while I'm in here, let me also...") — don't. Ask, or leave adjacent constructs alone. The user will call out the next issue if there is one.
- The pattern is the same as `feedback_hardening_minimal_scope`: stay strictly within the named target; no pattern-propagation.
- If in doubt about scope, do the minimum literal fix and stop. One-line targeted edits are cheap; over-sweeps cost trust.
- Reverting an over-sweep, even when the user hasn't asked for the revert, is often the right cleanup — but if the user says "it doesn't matter, leave it," take that at face value and don't touch it either.

## A change the fix needs to work is part of the fix (2026-10-17)

Not a sweep: a change without which the approved fix would not work in
the very case the user approved it for. Make it, and list it in the
report under the choices the user has not seen, saying why the fix
needed it.

**Why:** the user approved asking the server on every position switch so
the Manage/Stop button shows the right state. That alone would not have
reached the reported case: the button was not redrawn while a click was
in flight, so the server's answer could not be shown. I also made the
in-flight state redraw the button, disabled with its label, and listed
it as a choice. The user: "On Choice #4, that's good work. I was going
to mention that."

**How to apply:** the test is the reported scenario. If the approved fix
without the change still fails that scenario, the change is in scope;
if it only improves something nearby, it is a sweep, and this file's
rule stands.
