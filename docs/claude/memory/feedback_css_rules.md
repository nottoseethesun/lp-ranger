---
name: feedback_css_rules
description: "CSS rules: no inline styles, no zoom, no !important, let classes do the work, name colors in comments"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-18T03:15:19.221Z
---

# CSS rules

Merged from: feedback_no_inline_styles, feedback_no_css_zoom, feedback_no_important, feedback_css_classes_purpose, feedback_color_name_comments — those slugs no longer exist as
separate files; search this one.

## no inline styles

Never use inline `<style>` blocks or inline `style="..."` attributes. All styles belong in external CSS files.
**Why:** Project convention — zero inline styles. The only exception is dynamic `width` values set by JS.
**How to apply:** When creating new HTML pages (like help.html), add styles to the existing CSS files (style.css, 9mm-pos-mgr.css) or create a dedicated external CSS file.

## no css zoom

Never introduce the CSS `zoom` property anywhere in the project — not on `body`, not on any element, not as a scaling tactic for icons/modals, not as a defensive override.

**Why:** `zoom` was removed project-wide on 2026-04-20 after the legacy `body { zoom: 1.5 }` was replaced with natural-pixel authored values (Option B: scale px values 1.5×). The user explicitly wants zero `zoom` anywhere — it's non-standard, complicates measurement/math, and we've committed to straight px sizing. Concrete confirmation: removing the body zoom also fixed a Chrome password-manager autofill dropdown that had been misaligned relative to the input it was anchored to — browser UI anchors its own chrome against the real viewport, not the zoomed layout, so zoomed bodies offset these overlays.

**How to apply:** If a future task tempts me to use `zoom` (e.g., quick uniform scaling, IE-compat shim, scaling a child element), don't. Reach for `transform: scale()`, `font-size` bumps, or direct size values. Flag any PR/branch that re-introduces `zoom:` in CSS and remove it.

## no important

Never use `!important` in CSS.
**Why:** It breaks the cascade and makes styles impossible to override cleanly. Always solve specificity issues by using equal or higher specificity selectors, source order, or restructuring.
**How to apply:** When a style isn't applying, check which rule wins via specificity. Match or exceed that specificity in the override, or ensure the override CSS file loads after the one being overridden.

## css classes purpose

Don't override CSS classes to change their meaning. If a class is designed for compact text in the app (e.g., `9mm-pos-mgr-help-list` at 11px), don't override it to 22px on another page. Instead, remove the class and let that page's own CSS handle the styling via element selectors.
**Why:** User said "make them serve their purpose; don't just override them!!!"
**How to apply:** When content appears in multiple contexts needing different styling, use the class in the compact context and plain elements (styled by page-specific CSS) in the spacious context.

## color name comments

Whenever a hex code (`#D4AF37`) or RGB triple (`212;175;55`) appears in code, include the standard color name in a comment immediately adjacent — e.g.:

```js
// Antique White (#FAEBD7) on Metallic Gold (#D4AF37)
"[dust-unit-price]": "\x1b[38;2;250;235;215;48;2;212;175;55m",
```

**Why:** Hex/RGB values are unreadable at a glance. The color name (Metallic Gold, Antique White, Dirty White, Dark Forest Green, etc.) gives a reviewer instant understanding without firing up a color picker.

**How to apply:**
- Applies going forward, in any new code that uses color codes (CSS, ANSI escape sequences, JS strings, etc.).
- The user established this rule on 2026-04-28 specifically for `console.log` color codes; they explicitly said NOT to retrofit non-console-log color codes at that time.
- For new color additions: name first (or alongside) the hex/RGB. When updating an existing color, also add the name comment if missing.
- Use the standard/canonical color name (HTML/CSS named color, Pantone/common name) — capitalize the words ("Metallic Gold," not "metallic gold").

## CSS values ship with the build (2026-10-17)

Anything that shapes the layout, such as the dialog height, reaches the
page either as JSON bundled at build time or written into CSS (the
generated `ui-tokens.css`). Never from the server at runtime.

**Why:** the user, 2026-10-17, when I proposed having the server write
the dialog-height stylesheet: "Anything related to CSS such as Dialog
Height, must either be shipped to the client as json in the build
bundle, or in CSS", because "otherwise the u.i. will flicker and flash
at start-up". A value that arrives after first paint makes the page
jump when it lands.

**How to apply:** non-layout UI settings come from the server like any
other value, overrides included (`ui-defaults_non-layout_for-server-up-scenario.json`,
`GET /api/ui-defaults`); the two the page needs while the server is down
are built in (`…_for-server-down-scenario.json`). Layout values stay
build-time: `npm run build` writes `ui-tokens.css` from
`ui-defaults_layout.json`, an operator's override included, and a change
takes effect at the next build. The split is the user's, 2026-10-17;
docs/engineering.md § "The Dashboard's Three Settings Files".
