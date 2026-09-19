---
name: feedback_prose_style
description: "Prose style: short sentences, concise replies, no redundant restatement of known rules, no slop words ('honest', 'straight') or empty structural announcements, spell out small numbers, no gwei/wei, 'aborted' not 'paused'"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-09-19T19:32:11.783Z
---

# Prose style

Merged from: feedback_short_sentences, feedback_concise_responses, feedback_spell_out_small_numbers, feedback_no_gwei, feedback_paused_vs_aborted — those slugs no longer exist as
separate files; search this one.

## short sentences

Keep writing — both documentation prose and chat replies — in short, bite-sized sentences. Break long compound sentences into multiple shorter ones. One idea per sentence when possible.

**Why:** The user finds long sentences with multiple clauses hard to parse. Short sentences make technical explanations land cleaner and are easier to skim.

**How to apply:** After drafting any prose (especially in `docs/engineering.md` and other explanatory text), re-read each sentence. If it has more than ~20 words or more than one clause joined with em-dashes / semicolons / nested parentheticals, split it. Favor period + new sentence over em-dash continuation. This applies to both docs and chat responses.

## concise responses

Keep responses short. Long explanations push prior Q&A off screen, making the conversation hard to follow. When the user asks a confirmatory yes/no question, answer yes/no — don't pad with caveats, sanity checks, or "make-work" lists they didn't ask for.

**Why:** User explicitly called out a long defensive answer as "a bunch of make-work for me to read through" after asking a simple confirmation. Long answers also push prior turns off screen.

**How to apply:** Answer directly in 2-3 sentences. For yes/no questions, lead with yes/no and stop. If a real caveat exists, surface it in one sentence. If more detail might be needed, offer to elaborate rather than dumping it. Save defensive enumeration for when the user is actually unsure or asked an open-ended question.

## no confusing redundancy

Don't restate what is already established — the repo's documented rules,
standard procedure, or something covered earlier in the same conversation.
A restated fact does not read as a reminder. It reads as a NEW caveat, so
the user stops to work out what changed, finds nothing, and has lost the
time.

**Why:** After a clean merge I closed with "a fresh clone needs
`npm run build` before `npm start`". That is already the rule for
`bundle.js`, `disclosure-content.js`, `build-info.js` and the fonts, and
CLAUDE.md's script list already states it. The user replied "Fresh clones
always need `npm build` first", then "Please avoid confusing redundancy"
(2026-08-05).

**How to apply:**
- Before adding a closing caveat, ask whether it is already true of the
  project generally. If a new artifact just joins an existing category
  (one more generated file, one more gitignored path), it needs no
  mention — the category's rule already covers it.
- Flag an operational step only when it is NEW or CHANGED
  ([[feedback_flag_operational_side_effects]] is about genuinely new
  steps, not restatements of standing ones).
- Same for summaries: don't re-explain a decision the user already made,
  and don't repeat a caveat given earlier in the conversation.
- When unsure whether something is known, leave it out. The user asks
  when they want more.

## no slop words, no empty structure

Two habits the user named as slop, 2026-09-19.

**"Honest", "honesty", "straight", "to be straight with you".** Do not
describe data, code or a report as honest, and do not announce your own
candour. Say what the thing does. "The row is honest" is nothing; "the
row shows dashes rather than a figure it cannot compute" is the claim.
Applied to myself it is worse — "let me be straight with you" implies
the surrounding text was not, and spends a line saying so.

**Structural announcements that carry no content.** "The answer splits
in two", "there are two sides to this", "it comes down to one thing" —
these promise a shape and deliver nothing. Either name the two things in
the same breath, or drop the sentence and start with the first one.

**Why:** the user, on a report about a P&L row: *"Avoid references to
'honesty' and 'straight' — that is SLOP"*, and earlier in the same
exchange, *"avoid abstract AI spew like 'it splits in two' where there's
nothing specific"*.

**How to apply:**
- Before writing an adjective about a figure or a row, ask whether it
  names a behaviour. Honest, sensible, reasonable, healthy, clean:
  usually not. Replace with what the code does.
- Never narrate your own reliability. The reader judges that from the
  content.
- Cut any sentence whose whole job is to announce that a list follows.
  The list announces itself.
- Related: [[feedback_no_internal_constants_in_design_talk]] (describe
  behaviour, not implementation), [[feedback_concise_responses]].

## spell out small numbers

For numbers under 10, unless the context is explicitly mathematical,
avoid the numeral and use the English spelling: "the 3-in-window"
→ "the three in-window".  User gave this as a general writing rule
during the daily-cap copy pass (2026-07-23) and followed up with a
pluralization correction on the same phrase ("the three in-window
trigger" → "the three in-window triggers").

**Why:** Editorial standard for all user-facing copy (info popovers,
Manual, modal text) and prose generally.

**How to apply:**
- Prose counts: spell out one–nine ("three rebalances", "two
  clarifications").
- Explicitly mathematical context keeps numerals: multipliers ("4×"),
  percentages ("±5%", "0.5%"), settings values and ranges
  ("5–20", "min 1, max 200"), tick/price numbers, code identifiers.
- After converting a numeral phrase, re-check the noun's number
  agreement ("triggers", not "trigger", when the count is plural).
- Applies to NEW copy being written; do not sweep existing copy
  unless asked ([[feedback_fix_only_what_was_asked]]).

## no gwei

Never use gwei (or wei) units anywhere except the lowest-level point where they're truly required. Always prefer native-coin units (PLS/ETH/etc) and USD.

**Why:** User finds gwei cognitively awkward — mentally converting gwei → native → USD is extra friction. They want to reason in the units they actually hold and top up (e.g., PLS on PulseChain) and in USD. Applies in **prose, UI, AND code**, not just user-facing text.

**How to apply:**
- Prose, tables, tooltips, UI strings: native token units (PLS, ETH, etc.) and USD.
- Code: variable names, log lines, comments, tests should also avoid gwei. Use native-coin units (e.g., `pls`, `eth`) or raw wei.
- Keep raw wei/gwei ONLY at the boundary where the RPC or contract requires it (bigint math passed to ethers, gasPrice fields, etc.) — and only that final conversion line.
- Gas units (e.g., "1.9M gas") are fine and chain-agnostic — they're unit-counts, not gwei.
- If you reference gasPrice in logs, convert to native (`X PLS per 1M gas`) or just report the total native cost the user cares about.

## paused vs aborted

The bot has an internal flag `botState.rebalancePaused: true` that gets set in `src/bot-loop.js`'s `_handleError` when a swap aborts on slippage. The flag name suggests "paused with intent to resume" but the actual semantics are:

- The rebalance effort has **terminated**, not paused.
- The bot will NOT retry on its own. Slippage problems require user action 99.9% of the time.
- To re-attempt, the user must change Slippage in Mission Control (server-routes.js's POST /api/config auto-clears the flag) AND/OR re-click Manage (handleManage's `_stampReopenFlagsOnLive` re-arms forceRebalance).
- Auto-retire (30-min drain timer) eventually flips the position to `status=stopped` if the user does nothing.

**Why:** User explicitly corrected me 2026-06-18 in two separate turns: first "Re-open isn't paused — it's been aborted" when I tried to put "Re-open paused" on a tooltip, then "What were you thinking of?" when I wrote "paused re-open" in an audit summary. The flag name leaks into prose if I'm not careful.

**How to apply:**
- In user-facing prose (tooltips, modal text, summaries, conversation responses): say "aborted" (or "halted", "terminated"). Never "paused".
- In code comments referring to the flag by its identifier (`rebalancePaused`): use the flag name but follow with "(aborted)" or "(slippage abort)" so future readers know the user-facing meaning.
- In JSDoc descriptions of functions that touch the flag: lead with the semantics ("aborted state") and mention the flag identifier as the storage detail.
- Server logs / variable names can stay as `rebalancePaused` for now (renaming would be a wide ripple). The discipline is in the prose layer.

The same distinction applies to `rebalanceFailedMidway`: it's a "stuck in mid-rebalance recovery" state, not a graceful pause. The bot is in a weird limbo, not "waiting".

Cross-links: [[feedback_concise_responses]] (don't muddy short summaries with imprecise terms).
