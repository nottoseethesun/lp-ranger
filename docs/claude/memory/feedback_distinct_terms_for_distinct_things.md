---
name: distinct-terms-for-distinct-things
description: Name every entity once and never reuse a word for two of them; no pronouns or bare nouns where more than one candidate exists
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-13T22:13:00.315Z
---

When explaining anything with more than two similar entities, define each
one by name up front, then use that exact name every single time. Never
let one word stand for two things, and never write "that NFT", "it", "the
token", "the chain" where a reader has to guess which one is meant.

In this project the traps are real and specific:

- **"token"** means the ERC-20s in the pair (HEX, WPLS) AND the ERC-721
  position. Say "position NFT" for the latter, always.
- **"chain"** means the blockchain, AND the rebalance series, AND the
  app's inferred version of that series, which can differ from what
  actually happened on-chain.
- **"first NFT"** can mean the oldest one the wallet ever held, or the
  earliest one in the inferred series. Those are different NFTs whenever
  the oldest arrived by transfer rather than by mint.

**Why:** the user had to ask the same question eight or nine times
because each answer reused a term for a different thing, or left a
pronoun pointing at the wrong antecedent. Every re-ask was caused by
wording, not by the subject being hard. It wasted a large part of a
session and the user said so plainly.

**How to apply:** lead with a short terms list when several similar
entities are in play. Repeat full names instead of pronouns even when it
reads repetitively — repetition is cheaper than a re-ask. Before sending,
reread each pronoun and bare noun and confirm exactly one candidate
exists; if two do, replace it with the name. See [[feedback_prose_style]]
and [[feedback_one_thing_at_a_time]].
