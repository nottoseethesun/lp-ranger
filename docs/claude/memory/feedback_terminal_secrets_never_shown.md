---
name: terminal-secrets-never-shown
description: "A password, private key or api key typed at a terminal prompt never shows on screen; every such prompt goes through src/lib/ask-password.js"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f8b08a58-72ba-4f26-a891-71b9e99630e4
  modified: 2026-10-24T04:55:09.049Z
---

Nothing secret typed at a terminal shows on screen: a password, a
private key, an api key. Every prompt for one goes through
`src/lib/ask-password.js`, which gives Node's readline an output that drops
what it is given, so the line still edits and nothing echoes.
`--headless`, bot.js, scripts/import-wallet.js and the bookkeeping
report's Moralis key prompts all use it.

**Why:** the user, 2026-10-21, on learning the report's prompts showed
what was typed: "fix that; of course, a password typed on the terminal
should never show up". scripts/import-wallet.js had a readline of its
own that showed the private key and the password; it was switched too,
since the rule covers it.

**How to apply:** a new prompt for a secret calls `askPassword`, never a
readline of its own. Test it with a stream standing in for the terminal
(test/ask-password.test.js), and see it on a real terminal under
`script`. A plain yes/no confirm may show what is typed. Related:
[[builtin-before-package]].
