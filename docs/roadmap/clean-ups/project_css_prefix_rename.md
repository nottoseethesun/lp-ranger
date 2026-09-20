# Letter-First CSS Class Prefix

> **Status:** Nice-to-have / polish &mdash; not a bug. Every style
> renders correctly today. Funds are never at risk.

## Plain language

Every CSS class in this project starts with a digit (`9mm-pos-mgr-…`).
CSS cannot begin an identifier with a digit, so each of the several
hundred selectors carries an escape (`.\39 mm-pos-mgr-…`). It works, but
it is fragile in one specific way: if a formatter wraps a line right
after that escape, the selector silently changes meaning instead of
failing loudly.

## Detail

That is not hypothetical. Prettier 3.9.5 wrapped one such selector and
broke the auto-compound toggle, with every gate still green &mdash; the
mangled rule was still valid CSS, just pointed at something else. The
isolated repro lives at
`../bug-reports-on-dependencies/prettier-css-hex-escape-linewrap/`.

Two guards exist now: the custom `9mm/no-linebreak-after-escape`
stylelint rule rejects an escape stranded at a line end, and the
six-digit `\000039` form is immune to the wrap. A letter-first prefix
would remove the class of problem rather than guarding it.

## Fix when prioritized

Pick a letter-first prefix (`lpr-`, `pm-`, …) and sweep: all selectors
in `public/*.css`, every `class="…"` in the served HTML, and every JS
reference (`classList.*`, `querySelector`, `matches`,
`getElementsByClassName`, template strings). It is mechanical but wide,
and it loses the brand echo of the original name &mdash; which is why it
is parked rather than scheduled.
