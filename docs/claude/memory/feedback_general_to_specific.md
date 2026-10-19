---
name: feedback_general_to_specific
description: "Open every explanation at the highest level — name the thing and the situation in the operator's terms — then descend to mechanism and evidence. Never start mid-explanation."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-10-19T17:58:59.715Z
---

Start at the top and work down. The first sentence names **what is being
discussed**, in the terms the user sees it — the position, the panel, the
figure, the transaction — before any mechanism, file, field or function
appears.

**Why:** the reader does not hold the frame the answer was written
inside. An opener like *"it's real, and here's the trace: exactly three
things can write the open period's gas coins"* is unreadable, because
every noun in it depends on a paragraph that was never written. The user,
repeatedly, on exactly this: *"you are starting in the middle, making it
unintelligible"*, *"what in God's name are you talking about"*, *"you
always omit the context"*, and *"start with what you are talking about:
E.g., the P&L Table at the bottom"*.

**The order:**

1. **The subject and the scenario.** "Your position #164418 was minted on
   2026-08-25, and that mint cost 3,069 PLS in gas."
2. **What is wrong or being asked, in operator terms.** Which number, on
   which screen, reading what.
3. **The mechanism.** Now names may appear — the field, the function, the
   file and line.
4. **The evidence.** The measurement, the trace, the log line.

**Tells that it is starting in the middle:** the first sentence contains
a code identifier; it opens with "it" or "that" referring to something
unnamed; it answers a question the reader has not been given yet; it
leads with a verdict ("it's real", "confirmed", "nothing to fix") before
saying what "it" is.

**The user's own drill for this is the word-budget tiers** — "40/100/200,
general to specific" — where each tier must stand alone and each must
open by naming the subject. Practice the 40 first: if the subject is not
in it, the longer versions will start in the middle too.

## No shorthand for what the operator does (2026-10-19)

Name the operator's action and what the screen shows, in a full
sentence, every time. Never compress an action or an event into a noun
phrase the reader has to decode.

**Why:** in one audit report the user called four items "gibberish" for
exactly this: "a refused save" ("A refused save from when the user
clicks the Save button? See, I have to guess through your gibberish.
Stop gibberishing."), "a second unlock" ("What's 'a second unlock'?"),
"the new NFT inherits the block" ("An NFT cannot 'inherit' a block"),
and "Its Rebalance Events list". Earlier the same day: "What's 'the
list' in this context?" They also asked that an explanation open with a
heading and "an initial statement of the problem", and go in order:
"you are skipping around there so I cannot understand".

**How to apply:**
- Write "you type a value and click Save, and the server turns it down"
  rather than "a refused save"; "you enter the wallet password in the
  Unlock Wallet dialog a second time" rather than "a second unlock".
- Use the screen's own words for each control, dialog and table, quoted
  as the screen shows them.
- Each item: a heading, one sentence stating the problem, the normal
  behavior, then the steps of what goes wrong in order, what the
  operator sees, and the fix.
- No metaphors for program state: a figure, a flag or a wait is
  "kept", "left in place" or "carried over", said with what keeps it.

Related: [[feedback_operator_sees_ui_not_logs]] (answer in badge and
dialog terms, not log terms), [[feedback_no_internal_constants_in_design_talk]]
(describe operator-facing behavior, not implementation constants),
[[feedback_distinct_terms_for_distinct_things]] (one word per entity),
[[feedback_prose_style]].
