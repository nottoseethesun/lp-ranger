---
name: Help cursor on any element with a title
description: Any inert element with a non-empty title attribute must show the question-mark help cursor on hover
type: feedback
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-10-24T05:23:58.365Z
---
Any non-interactive element (div/span) with a non-empty `title` attribute must show the `cursor: help` (question-mark-anchor) on hover. Interactive elements (button, a, input, select, textarea) keep their native cursor.

**Why:** The user said "always on hover when there is hover text, remember?" — discoverability of tooltips: if the cursor doesn't change, users don't know hovering reveals info. This is a project-wide UI convention, not per-element.

**How to apply:** A single global CSS rule lives at the top of `src/client/web/9mm-pos-mgr.css`:

```css
div[title]:not([title=""]):hover,
span[title]:not([title=""]):hover {
  cursor: help;
}
```

Don't add per-component cursor overrides for tooltips — the global rule handles it. When adding a new `title="..."` to an inert element, you get the help cursor for free. When clearing a tooltip dynamically, set `title=""` (not just empty content) so the cursor reverts.
