---
name: fix-only-what-was-asked
description: "Fix X changes only X; hardening is no refactor beyond the fix; one thing at a time, and a yes/no question gets yes or no"
metadata:
  type: feedback
---

# Scope: only what was asked

Merged from: feedback_hardening_minimal_scope, feedback_one_thing_at_a_time — those slugs no longer exist
separately; search this one.

## fix only what was asked

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

## hardening minimal scope

When the user says we're "hardening a production release," running burn-in, or otherwise stabilizing for soft-launch, **keep every change strictly inside the requested boundary**.  If the request names a single modal/component/file, do not touch its neighbours — even for parsimony's sake, even for consistency, even if a nearby element clearly follows an older pattern.

**Why:** Each new touch surface is another place for a regression to appear during burn-in and reset the soft-launch clock.  On 2026-05-13, while restyling the Pool Details modal alone (PR #128), the user said three times in a row: "Limit the change to just this modal dialog.  Don't go wild throughout the app.  We are hardening a production release." — making it clear that pattern-propagation work (introducing `<section>` semantics, restructuring siblings, etc.) is unwelcome during this phase.

**How to apply:**

- If the user names a target (a modal, a button, a card, a specific file), edit *only* that target's markup/JS/CSS — even if neighbouring elements share the same anti-pattern.
- Do not "improve consistency" across unrelated parts of the app.  No incidental refactors, no renames, no helper extractions outside the named target.
- Audit `git diff --stat main` after each change in hardening mode and confirm the file list matches the named scope.  If it expanded, undo the spread.
- When the user invokes hardening / burn-in / production-release language, treat it as a hard scope lock that lasts until they explicitly green-light larger work again.

## one thing at a time

Two failures, same root, repeated all through 2026-09-02/03 until the
user was shouting:

1. **Answering more than was asked.** A yes/no question gets "yes" or
   "no" first, then at most a few lines. Twice the user asked one and
   got several paragraphs; both times they said the reply was useless to
   them and they would ignore it. Over-answering does not merely waste
   words — it destroys the answer.
2. **Widening the scope.** Asked to investigate the **Per-Day** table, I
   surveyed Per-Day *plus* the Current and Lifetime panels in one table
   and then kept defending the two nobody asked about. It took several
   exchanges just to establish which panel I meant.

Their words: *"It is almost impossible to get you to control spew"* and
*"you work hard against doing only one thing at a time."*

3. **Answering before the answer exists.** 2026-10-03, asked "so the
   global rpc handler is for reads only?" The true answer was one
   sentence — everything uses it, sends included. But I had not finished
   tracing the write path when I started replying, so instead of the
   answer I published the half-built model: a three-way breakdown of
   internal components, with module names, and a "NonceManager
   exception" that turned out not to be an exception at all. Five
   exchanges of the user correcting my taxonomy followed, ending in
   *"nothing you've said about this topic makes sense"* and *"you could
   have said that initially, and saved me half an hour of work."*

   This is not over-answering. The words were not the problem — the
   missing conclusion was. A component inventory is what you produce
   while still working out the answer, and handing it over makes the
   user debug your understanding instead of reading a result.

**How to apply:**

- Answer the question asked, about the thing named. Stop.
- Yes/no first, on its own. Justify only if asked, or in one or two
  lines.
- **Finish the investigation before replying.** If the yes/no is not yet
  known, keep working — the tools are free, the user's attention is not.
  A scope question ("is X only for Y?", "does this apply to
  everything?") wants the scope, and nothing else answers it. Never
  publish the component breakdown that preceded the conclusion; if a
  qualification turns out not to hold, the user should never have seen
  it.
- Do not present findings about B while the subject is A. If B looks
  broken, say so in **one line naming the panel and the exact figure**
  — "LIFETIME panel → PROFIT reads X, should read Y" — and return to A.
  Not flagging a real problem is also wrong; burying it in a survey is
  what fails.
- Never restate an argument the user has already accepted or rejected.
- Before sending, ask: did they ask for this? If not, cut it.

Related: [[feedback_prose_style]], [[feedback_fix_only_what_was_asked]].
