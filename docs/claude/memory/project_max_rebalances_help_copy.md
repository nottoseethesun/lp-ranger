---
name: project_max_rebalances_help_copy
description: "OPEN BUG, copy (found 2026-10-17): the Max Rebalances Per Day help dialog recommends 5-20 and calls 200 the maximum, but the server refuses anything above 12"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-17T07:19:22.720Z
---

**Open bug, found 2026-10-17, not fixed: the user's call which figure
is right.** The Max Rebalances Per Day help dialog
(`public/param-help-content.js`) recommends 5 to 20, suggests "20+" for
active markets, and calls 200 the maximum. `src/config-bounds.js` refuses
any saved value above 12, and `docs/configuration.md` agrees with it
("1 to 12"). The shipped-defaults reader (`src/bot-config-defaults.js`)
allows 1 to 200 in the JSON file, so the two server-side bounds differ
as well.

What an operator sees: following the help dialog's advice to set 20,
Save answers "that value was not accepted", with the field put back.

**Why:** copy that recommends a value the server refuses sends the
operator into a refusal with no way to tell which side is wrong.

**How to apply:** ask the user whether the cap is 12 or 200. Then make
the help text, `config-bounds.js` and the JSON normalizer agree, with the
bound in one place ([[feedback_one_literal_per_shipped_default]]).
