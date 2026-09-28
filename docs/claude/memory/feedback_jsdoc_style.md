---
name: feedback_jsdoc_style
description: "A JSDoc block answers what the thing does, how it works, and how it integrates with the app — as one flowing argument, general to specific, every term explained before it is used. Never a post-mortem of the bug that prompted the code."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-28T17:59:08.758Z
---

A doc block answers three questions, in this order: **what does this do,
how does it work, and how does it fit the rest of the app.** Everything
else is an intruder.

**Why:** the user rejected two drafts of the same block. The first
retold the incident that prompted the code — the outage, the counts, the
chain of causes — and they called it *"story telling"*, asking instead
for *"what does it do, how does it work, and how does it integrate with
the rest of the app."* The second fixed the content but read as a list
of asserted facts with a dangling reference, and they asked for it again:
*"making sure that everything reads logically flowing from one point to
another, with all important terms already explained before they are used,
and moving from the general to the specific (storytelling, not
regurgitating detail)."*

Note what "storytelling" means in each. Rejected, it means *recounting
an episode*. Wanted, it means *one connected argument a reader can
follow*. The opposite of the good sense is not brevity — it is a heap of
true statements in no order.

**How to apply:**

1. **Open at the highest level, in plain words.** The first sentence
   names the job, with no identifier in it if that can be helped. "Name
   the chain the app runs on, from configuration rather than by asking an
   endpoint." Descend from there.
2. **Introduce every term before leaning on it.** If the argument turns
   on `staticNetwork`, gloss it where it first appears. If it turns on
   `send()` being where the rate limiter sits, establish that before the
   sentence that depends on it.
3. **Never leave a pronoun or noun-phrase without an antecedent.** "the
   result" was the specific failure: it appeared before anything had been
   described as producing one. Name the thing — "the `Network` built
   below".
4. **Make each paragraph follow from the last.** Ask what the reader now
   knows that they did not before, and let the next point stand on it.
   Where a trade-off exists, hang it on the thing that causes it rather
   than appending it as a separate fact.
5. **Prefer prose to bullets for reasoning.** Bullets assert in
   parallel; they cannot carry "and therefore". Keep a list only for
   things that genuinely are parallel.
6. **Put mechanics last, then the tags.** Where a value is read from,
   what an unrecognised input does, the null case — these are specifics,
   so they come after the shape of the thing is clear.
7. **`@throws` says why, not only when.** "rather than leave a provider
   to settle on a chain nobody chose" is the content; "when chainId is
   invalid" alone is not.

**Where the incident goes instead:** the memory file, the test file's
header, and the architecture note in CLAUDE.md. A regression test header
is the right home for a chain of causes, because reproducing it is that
file's job — but the same flow rules apply there too.

The worked example is `_knownNetwork` in `src/bot-provider.js`, written
against this standard on the third attempt.

Related: [[feedback_general_to_specific]] (the same ordering, applied to
answers), [[feedback_multiline_comment_style]] (`/*-` for in-body
comments; `/**` for doc blocks), [[feedback_prose_style]] (short
sentences, no slop words), [[feedback_distinct_terms_for_distinct_things]],
[[feedback_verify_symbols_a_comment_names]] (a doc block must not lie).
