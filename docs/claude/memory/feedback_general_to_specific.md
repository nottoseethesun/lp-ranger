---
name: feedback_general_to_specific
description: "Explain in the operator's terms: name the thing first, define each term, no names of my own coining, scenarios step by step and true to the app's model (one password), behavior before functions, no internal constants, badge and dialog terms, the log being my instrument"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-28T05:31:27.049Z
---

# Explaining to the user

Merged from: feedback_explain_behavior_not_call_sites, feedback_no_internal_constants_in_design_talk, feedback_operator_sees_ui_not_logs — those slugs no longer exist
separately; search this one.

## general to specific

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

**Coined names count, and so does a compressed scenario (2026-11-27).**
In an audit report I called last round's feature "the catch-up" and
described a misconfiguration in one clause. The user: *"The reader
won't know what 'catch-up' means: Again, you wasted my time but saved
maybe three seconds of yours: Re-explain"*, and *"I have to guess since
you saved your time, but wasted mine … You'll have to re-explain like a
smart AI."* On a third item they asked me to *"define and re-explain
first"*: I had written "if the two wallets share a password", but the
app uses one password for every wallet and key, so the scenario as
written could not happen.
- A name I gave a feature in conversation is not the reader's: say what
  the feature does on screen each time ("each tab asks the server for
  its status every three seconds, and closes its own Unlock dialog when
  the answer says the server holds the key").
- Define each term a scenario rests on before the steps (the server's
  wallet, locked, the address's wallet), then number the steps, each
  with what the operator does and sees.
- Check the scenario against the app's model before sending it: one
  password for every wallet and key; one wallet stored at a time.
- It happened again the same day: I wrote "a page loaded during a
  refused launch's 7.5 seconds", a shorthand of my own, and the user
  asked *"What's 'a refused launch' - you are short-circuiting critical
  points so no one can understand what you mean"*. Say what the server
  does instead ("LP Ranger refuses to start, because PRIVATE_KEY is for
  another wallet than the one imported; it shows why and exits 7.5
  seconds later"), and keep such shorthand out of the docs too: with
  the fix the user approved, I replaced it there with plain words
  ("while the server, having refused to start, waits to exit").
- A command is named in full each time, never by a part of it. In two
  audit reports I wrote "the flag" for
  `npm run build-and-start -- --delete-all-caches-and-logs`, and the
  user asked (2026-11-27): *"'After the flag' - what flag; idk what you
  are talking about"*. Write the whole command, and say what it does
  ("it asks you to type YES, stops LP Ranger, then deletes every cache
  and log") before what goes wrong with it.

Related: [[feedback_operator_sees_ui_not_logs]] (answer in badge and
dialog terms, not log terms), [[feedback_no_internal_constants_in_design_talk]]
(describe operator-facing behavior, not implementation constants),
[[feedback_distinct_terms_for_distinct_things]] (one word per entity),
[[feedback_prose_style]].

## explain behavior, not call sites

When reporting what was changed and why, lead with **what happens** —
the feature, what went wrong, what a reader or operator would see. A
function name is a pointer for someone who has understood the point and
now wants to read the code. It is never the explanation.

**Why.** Twice on 2026-10-02. First: *"You've spewed out a lot of vague
material."* Then, quoting a paragraph of mine back verbatim: *"What the
fuck does this mean? … Do you have any idea how a reader has no idea what
you mean there?"*

The paragraph was accurate and useless:

> I first put the hold's announcement in `_drain` — but `acquire()` has
> two fast paths that return without ever draining once the halt is
> clear. On the common path the line would never have fired, and the
> deadline would have stayed set until some later moment when a queue
> happened to form, announcing itself then. It now sits in
> `_haltRemainingMs`, the one function every path asks.

Four private identifiers, no statement of what anybody would observe.
The same content, as it should have been written:

> When every rpc endpoint stops answering, the app stops sending
> requests for an hour. It announced the start of that hour and not the
> end. I added a line for the end — and put it somewhere the code only
> reaches when requests are queued up, which they usually are not by the
> time the hour runs out. So it would not have printed at all, and the
> app would still have believed it was paused: hours later, the first
> time requests did pile up, it would have announced a wait that had
> ended long before. It now sits on the check every request makes, so
> whichever asks first notices and says so, once.

**How to apply.**

- Order: the feature, then the behaviour that was wrong, then what a
  reader would see, then the fix. File and function names come after
  that, if at all.
- A sentence carrying two private identifiers and no observable
  consequence is a sentence to rewrite, not to footnote.
- This applies to chat, commit messages and release notes alike. The
  commit may then name the call site, because whoever reads a commit is
  about to read the diff — but even there the first paragraph says what
  happens.
- The test: could someone who has never opened the file follow it? If
  not, it is not an explanation yet.

**Internal shorthand counts too (2026-10-17).** A report's open bugs
read "A retried send can send a move twice" and "a cancel answered
'already known' fails the move". The user: *"What's a 'send' - we have
compound and rebalance. … What move? … you are just failing hard at
explaining what you are talking about."* "Send", "move", "slot",
"settle" are the code's words, not the operator's. Name the operator's
action (a rebalance, a compound), the step inside it (the removal of
liquidity, the swap, the mint, the fee collection), and what the
operator would see. When a report needs a mechanism term such as the
wallet's transaction sequence number or the speed-up and cancel, define
it once, in plain words, before the first item that uses it.

Related: [[feedback_no_internal_constants_in_design_talk]] (same
instinct, about constants), [[feedback_operator_sees_ui_not_logs]] (same
instinct, about app state), [[feedback_general_to_specific]],
[[feedback_prose_style]].

## no internal constants in design talk

When discussing a design or plan with the user, describe the operator-facing BEHAVIOR, not internal implementation constants (validation ranges, thresholds, magic numbers).

**Why:** surfacing an internal constant invites confusion and tangents without adding value. Concrete instance (2026-07-31): I mentioned the `[0,77]` ERC-20 decimals *validation* range while explaining the decimals heal; the user read it as a possible *fallback-value* strategy and we spent two turns clearing it up. The range was never operator-relevant.

**How to apply:** say "the heal uses a valid decimals value (on-chain or your manual entry), or it auto-stops — it never guesses" instead of naming the `[0,77]` check. Only surface an internal constant if it changes what the operator sees or must decide. Related: [[feedback_concise_responses]], [[feedback_kiss]], [[feedback_short_sentences]].

## operator sees the UI, not logs

The operator watches the dashboard — the Sync badge, the status pills,
the modals. They do not read `logs/lp-ranger.log`. When answering "is it
done", "is it safe to stop", "why is it doing that", lead with what the
UI shows and what it means. The log is the assistant's instrument for
establishing the facts, not the operator's interface.

**Why:** advice phrased around a log line is advice the operator cannot
act on without being told to go and grep, which is not how they use the
app. Told to watch for `Lifetime P&L for #165032 done`, the right answer
was "wait for the Sync badge to go green". Worse, a defect only visible
in the log is invisible in practice — if the UI reads Synced while the
history is short, the operator has no way to know, which is why the
badge must assert something real rather than merely "a scan returned".

**How to apply:** state the answer in UI terms first, and cite the log
only as the evidence behind it. When designing, ask what the operator
would see — a figure that is wrong but confident is worse than one
visibly absent. When a log-only signal matters operationally, that is a
sign the UI is missing something, not that the operator should learn to
grep. Related: [[feedback_no_internal_constants_in_design_talk]],
[[project_unmanaged_na_principle]], [[feedback_keep_browser_logs]].
