---
name: feedback_one_thing_at_a_time
description: "Answer only what was asked, about only the thing named, and only once you know the answer. Widening scope, over-answering a yes/no, or narrating a half-finished investigation forces the user to discard the reply and start over — it costs them more than saying nothing."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-03T21:12:14.483Z
---

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
