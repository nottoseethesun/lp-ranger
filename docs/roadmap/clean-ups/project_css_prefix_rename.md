# Letter-First CSS Class Prefix

> **Status:** Nice-to-have / polish &mdash; not a bug. Every style
> renders correctly today. Funds are never at risk.

## Plain language

The project's own CSS classes start with a digit (`9mm-pos-mgr-…`).
CSS cannot begin an identifier with a digit, so each of the several
hundred selectors naming one carries an escape (`.\39 mm-pos-mgr-…`). It
works, but it is fragile in one way: if a formatter wraps a line right
after that escape, the selector silently changes meaning instead of
failing loudly.

## Detail

That is not hypothetical. Prettier 3.9.5 wrapped one such selector and
broke the auto-compound toggle, with every gate still green. The wrap
cut the class name to `9` and turned the rest into a descendant type
selector: still valid CSS, now matching something else. The isolated
repro lives at
`../bug-reports-on-dependencies/prettier-css-hex-escape-linewrap/`.

Two guards exist now: the custom `9mm/no-linebreak-after-escape`
stylelint rule rejects an escape stranded at a line end, and the
six-digit `\000039` form is immune to the wrap. A letter-first prefix
would remove the class of problem rather than guarding it.

## Fix when prioritized

Pick a letter-first prefix (`lpr-`, `pm-`, …) and sweep: all selectors
in `src/client/web/*.css`, every `class="…"` in the served HTML, and every JS
reference (`classList.*`, `querySelector`, `matches`,
`getElementsByClassName`, template strings). It is mechanical but wide,
and it loses the brand echo of the original name &mdash; which is why it
is parked rather than scheduled.
