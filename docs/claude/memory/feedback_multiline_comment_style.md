---
name: Multi-line comment style
description: Prefer `/*- ... */` block form for multi-line comments over stacked `//` lines
type: feedback
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-09-17T06:55:45.018Z
---
For multi-line comments, use the block form opened with `/*-` (dash
after the star) and closed with `*/` on its own line, rather than
stacking `//` lines.

**Why:** Ancient JavaDoc (Sun Microsystems) convention: `/*-` marks
in-body multi-line comments — cleaner visual grouping with the leading
`-` as a marker distinct from `/**` doc blocks.

**How to apply:** Whenever writing a comment that spans more than one
line, use:

```js
/*-
 *  Explain why the code below does what it does, in as many lines as
 *  the reason needs.
 */
```

Both the opening `/*-` AND the closing `*/` go on their own lines —
not trailing any text line. Text starts on the line after `/*-`.
Single-line comments remain `//`. JSDoc file-header, class, and
function/method headers use `/**` — they are a separate, required
format for exported APIs.

**CSS exception:** stylelint-config-standard's `comment-whitespace-inside`
rule rejects `/*-` (the `-` is not whitespace). For `public/*.css`, use
plain `/* ... */` with a leading space. Do NOT disable the stylelint rule
to allow `/*-` in CSS — user rejected that approach.
