---
name: feedback_token_cost_first
description: "Before a large multi-agent spend, say roughly what it costs and offer a cheaper scope; the user watches Claude token costs"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 54faebf5-9812-48c8-8743-e2dde6ca5007
  modified: 2026-11-26T02:08:30.137Z
---

Before a spend of many agents, a fresh-reader loop over hundreds of
findings, say, say roughly what it costs (about as many agents as a
wave, millions of tokens) and offer a cheaper scope beside it. Do not
start it on an earlier, general approval of the approach.

**Why:** the user watches the cost. On the English audit, 2026-11-25,
told the loop would cost millions of tokens, the user chose "only fix
incorrect facts in the doc ... that should be pretty quick and a fairly
small cost in Claude tokens". Earlier, 2026-11-24, an audit's fixes
waited "until later on Tuesday when I have enough Claude Credits again".

**How to apply:** keep agents to what the task needs, give each a tight
brief that skips exploration, and pick a cheaper model for mechanical
work where quality allows (the fact fixers ran on Sonnet). See
[[feedback_audit_english_by_the_handoff]].
