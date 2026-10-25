---
name: feedback_numbers_stay_numbers
description: "Hold numeric data as numbers (BigInt, number); convert it to text only where it leaves the process, such as the json an answer sends"
metadata:
  node_type: memory
  type: feedback
  originSessionId: b6a0b30e-9cd6-4560-a6cd-597053c26378
  modified: 2026-10-25T04:32:03.648Z
---

Numeric data stays numeric where the app holds it. A form a destination
needs, such as decimal text for json, which has no BigInt, is made at
that boundary, never stored in the number's place.

**Why:** 2026-10-24, Bug #15. The deposit count kept the wallet's reading
on the bot state as BigInts, and the status answer, which sends the bot
state whole, failed on them. My first fix stored the reading as text. The
user: "Numeric data generally should not be stored as text; can you not
just transform it for the send?" The fix moved to `jsonResponse`
(src/server.js), which sends each BigInt as its decimal text, by the rule
the rebalance log already used ([[feedback_no_duplication]]).

**How to apply:** When a value cannot cross a boundary as it is (json, a
log line, a file format), convert it in the code that writes to that
boundary, for every value that crosses, rather than change how the value
is held.
