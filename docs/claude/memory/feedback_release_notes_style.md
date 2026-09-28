---
name: feedback_release_notes_style
description: Release notes need an Overview section naming the release after a Texas Ranger plus a one-line summary; every change states its user-visible consequence; technical bullets carry a category label and spell out causal links and payoffs. American spelling.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fbb9ad2b-bfb6-4113-a2f4-fcb15a7900da
  modified: 2026-09-28T19:38:38.155Z
---

# Writing release notes

Derived from the user's own edits to the 0.9 notes on 2026-08-08 —
compare what was drafted against what shipped:
<https://github.com/nottoseethesun/lp-ranger/releases/tag/0.9>

The structure I proposed was kept (Highlights → themed sections →
Technical at the bottom, under 200 words). Six things were changed, and
they are the pattern to follow.

## 1. Open with an Overview section

Every release gets an `## Overview` before Highlights, containing two
things:

- **A namesake line.** Releases are named after **notable, honorable
  gunslingers of the Old West**, Texas included but not limited to it —
  NOT Texas Rangers specifically, though a namesake may happen to have
  been one. 0.9 was "Williamson was the first official Texas Ranger,
  guardian of the Lone Star State." The line names the figure and says
  in one clause why they are remembered.

  "Honorable" is a real criterion, not decoration: the theme is the
  admirable side of the Old West, matching the project's identity (the
  README tagline, the tooled-leather crest, the Lone Star). Outlaws and
  killers do not qualify however famous.
- **A one-line summary of the release's character.** 0.9's was "Last
  couple stylistic (visual-only) items for dialogs, and an updated
  Screenshot Gallery." It tells an operator whether this release affects
  behavior at all.

Do NOT invent the namesake — propose the section and ask which Ranger, or
leave a clear placeholder. The name is the user's call.

## 2. Say what the change does FOR the reader

Not just what changed. The Close-button bullet gained "which was taking
up too much vertical space" — the reason it mattered. A change without a
consequence reads as churn.

## 3. Label technical bullets by category

"Close button pinned to the dialog box" became "**Dialog layout:** Close
button pinned…". The label lets a reader skip or seek by area.

## 4. Spell out causal links

An em-dash joining cause and effect was replaced with "since": "`line-height: 0`
**, since** at any positive value it made the paragraph's first line
taller". Related: [[feedback_prose_style]] favors a period or an explicit
connective over an em-dash continuation.

## 5. Name things fully

"New `npm run show-gallery` previews the Pages site" became "New
`npm run show-gallery` **project command** **builds and** previews". Say
what kind of thing it is and everything it does.

## 6. State the payoff

The shared-builder bullet gained "avoiding any duplication of logic".
Having explained a mechanism, say what it buys.

## 7. Draft short, then cut it in half again

Added 2026-09-28, drafting 0.9.5. A ~730-word draft was cut to ~300 on
the instruction *"Trim the word count by 60%"*, and one 75-word bullet
was then cut again to 20: *"Reduce to 20 words; the reader does not care
about details such as 'no saved value'."* Four rules came out of that
pass.

- **No history.** *"don't mention old stuff."* Cut the incident recap,
  the "down from 50%" framing, the before/after test numbers, and the
  "if you want the old behavior" paragraph. A release note says what the
  release does, not what the last one did. The operator reading it has
  no memory of the bug being fixed and does not need one.
- **Cut qualifiers that narrow who is affected.** "A position with no
  saved value…" is true and was struck anyway. Conditions and caveats
  live in the help dialog and the Manual; the bullet carries the
  headline.
- **End the bullet on the decision, with the reasons leading to it.**
  The Guard bullet started as "**now defaults to 15%.** <reasons>" and
  the user rewrote the tail as "…fees may never earn it back, **so the
  default loss is capped at 15% now**." Reason → reason → conclusion.
  When the figure moves to the end, drop it from the bold lead — it was
  stated twice otherwise, and the lead becomes a plain category label.
- **A word budget is a real number.** "20 words" meant twenty. Count
  them.

Still keep a change's consequence (rule 2) — the cut is to explanation,
never to the payoff. The one item that changes behavior on an install
that does nothing may keep more room than the others.

**And it was still too long after all that.** The user's verdict on the
shipped 0.9.5 draft: *"yes you still had bulked up the release notes and
obfuscated the main points a lot."* Three rounds of cutting landed at
~300 words and that was roughly three times what it should have been.
So the instinct is not merely "trim" — it is wrong at the outset, and
the correction is structural:

- **One line per change, and the line is the change.** Not the change
  plus its mechanism plus its trade-off. If a bullet needs a second
  sentence, the second sentence is usually the part to drop.
- **Technical Details is two to four sentences total, not paragraphs
  per topic.** It says what was wrong and what now happens. It is not
  the commit message, and pasting the commit body in is the specific
  habit that bloated 0.9.5.
- **Target a hundred words for the whole body.** Every explanatory
  clause competes with the four things a reader came for, and burying
  them is the actual failure — length is only the symptom.

## Also

- American spelling — see [[feedback_prose_style]].
- Prepend `docs/release-notes-header.md` — see
  [[reference_release_notes_header]].
- Scope the notes from the latest non-`v` tag; `--sort=-v:refname` puts
  legacy `v0.2.x` tags on top, see [[project_tag_format_no_v]].
